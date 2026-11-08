import {test} from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/index.js'
import {withRemoteState, getState} from '../../mcp/src/state.js'

const url = 'https://opengym-mcp.janw.eu/mcp'
const active = {MCP_HOSTNAME:'opengym-mcp.janw.eu', MCP_UPSTREAM_TOKEN:'a'.repeat(64)}

test('MCP host is isolated from the app, and app host refuses /mcp', async () => {
  const app = await worker.fetch(new Request('https://staging.example/mcp'),active,{})
  const missing = await worker.fetch(new Request('https://opengym-mcp.janw.eu/'),active,{})
  const appApi = await worker.fetch(new Request('https://opengym-mcp.janw.eu/api/config'),active,{})
  assert.equal(app.status,404)
  assert.equal(missing.status,404)
  assert.equal(appApi.status,404)
})

test('MCP unauthenticated requests cannot read an openGym profile', async () => {
  const res = await worker.fetch(new Request(url,{method:'POST'}),active,{})
  assert.equal(res.status,401)
  assert.equal(res.headers.get('Cache-Control'),'no-store')
})

test('MCP rejects malformed bearer and missing secret', async () => {
  for (const env of [{...active, MCP_UPSTREAM_TOKEN:'short'}, {...active, MCP_UPSTREAM_TOKEN:undefined}]) {
    const res = await worker.fetch(new Request(url,{headers:{authorization:'Bearer '+ 'a'.repeat(64)}}),env,{})
    assert.equal(res.status,401)
  }
  const bad = await worker.fetch(new Request(url,{headers:{authorization:'Bearer '+ 'b'.repeat(64)}}),active,{})
  assert.equal(bad.status,401)
})

test('MCP fails closed when owner identity is ambiguous', async () => {
  const env = {...active, ACCOUNTS:{getByName:()=>({fetch:()=>Response.json({error:'ambiguous'},{status:503})})}}
  const res = await worker.fetch(new Request(url,{headers:{authorization:'Bearer '+ 'a'.repeat(64)}}),env,{})
  assert.equal(res.status,503)
})

test('MCP remote state is request-local and restores local mode', async () => {
  const a = {workouts:[{id:'a'}],unit:'kg'}
  const b = {workouts:[{id:'b'}],unit:'lb'}
  await Promise.all([
    withRemoteState(a, async()=>{
      await Promise.resolve()
      assert.equal(getState().workouts[0].id,'a')
      assert.equal(getState().unit,'kg')
    }),
    withRemoteState(b, async()=>{
      await Promise.resolve()
      assert.equal(getState().workouts[0].id,'b')
      assert.equal(getState().unit,'lb')
    }),
  ])
})

test('authenticated MCP exposes read-only tools backed by the profile Durable Object', async () => {
  const uid = 'test-owner'
  const calls = []
  const env = {
    ...active,
    ACCOUNTS: {getByName: name => ({fetch: async req => {
      calls.push(name + ':' + new URL(req.url).pathname)
      return Response.json({id:uid})
    }})},
    PROFILES: {getByName: name => ({fetch: async req => {
      calls.push(name + ':' + new URL(req.url).pathname)
      const start = Date.parse('2026-11-08T18:00:00.000Z')
      return Response.json({state:{unit:'kg',
        workouts:[{id:'w1', d:'2026-11-08', start, end:start+600000, entries:[
          {id:'0025',sets:[{w:60,r:10,done:true,at:start+120000},{w:60,r:8,done:true,at:start+420000}]},
          {id:'2291',sets:[{w:70,r:10,done:true,at:start+240000}]},
        ]}],
        routines:[{id:'r1',name:'My routine',ex:[]}],customEx:[]},rev:1})
    }})},
  }
  const rpc = (id, method, params={}) => new Request(url, {
    method:'POST',
    headers:{authorization:'Bearer '+ 'a'.repeat(64), 'content-type':'application/json',accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id,method,params})
  })
  const init = await worker.fetch(rpc(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'unit-test',version:'1'}}),env,{})
  assert.equal(init.status,200, 'MCP initialization should succeed: '+await init.clone().text())
  const list = await worker.fetch(rpc(2,'tools/list'),env,{})
  assert.equal(list.status,200, 'MCP tools/list should succeed: '+await list.clone().text())
  const output = await list.text()
  assert.match(output,/list_routines/)
  assert.match(output,/get_workout/)
  assert.doesNotMatch(output,/log_workout/)
  const invocation = await worker.fetch(rpc(3,'tools/call',{name:'list_routines',arguments:{}}),env,{})
  assert.equal(invocation.status,200,'MCP tools/call should succeed: '+await invocation.clone().text())
  assert.match(await invocation.text(),/My routine/)
  const workout = await worker.fetch(rpc(4,'tools/call',{name:'get_workout',arguments:{workout_id:'w1'}}),env,{})
  assert.equal(workout.status,200,'get_workout should succeed: '+await workout.clone().text())
  const replyText = await workout.text()
  const rpcReply = JSON.parse(replyText.startsWith('event:') ? replyText.split('\n').find(x=>x.startsWith('data:')).slice(5).trim() : replyText)
  const details = JSON.parse(rpcReply.result.content[0].text)
  assert.equal(details.entries[0].sets[0].completed_at,'2026-11-08T18:02:00.000Z')
  assert.deepEqual(details.set_timeline.map(s=>s.exercise_id),['0025','2291','0025'])
  assert.deepEqual(details.set_timeline.map(s=>s.seconds_since_previous_completion),[null,120,180])
  assert.equal(details.set_timeline[2].seconds_since_previous_same_exercise_completion,300)
  assert.equal(details.rest_estimation_model.seconds_per_rep,3)
  assert.equal(details.rest_estimation_model.interval_estimates_available,true)
  assert.equal(details.set_timeline[1].estimated_set_duration_sec,30)
  assert.equal(details.set_timeline[1].estimated_idle_before_sec,90)
  assert.equal(details.set_timeline[2].estimated_set_duration_sec,24)
  assert.equal(details.set_timeline[2].estimated_idle_before_sec,156)
  assert.equal(details.set_timeline[2].estimated_same_exercise_recovery_sec,276)
  assert.equal(details.set_timeline[2].estimated_passive_since_previous_same_exercise_sec,246)
  assert.equal(details.entries[0].sets[1].estimated_same_exercise_recovery_sec,276)
  assert.deepEqual(details.entries[0].sets[1].estimated_passive_since_previous_same_exercise_range_sec,[228,264])
  assert.match(details.timing_note,/not measured rest/)
  const customWorkout = await worker.fetch(rpc(5,'tools/call',{
    name:'get_workout',arguments:{workout_id:'w1',seconds_per_rep:4}}),env,{})
  const customText = await customWorkout.text()
  const customRpc = JSON.parse(customText.startsWith('event:') ? customText.split('\n').find(x=>x.startsWith('data:')).slice(5).trim() : customText)
  const customDetails = JSON.parse(customRpc.result.content[0].text)
  assert.equal(customDetails.rest_estimation_model.seconds_per_rep,4)
  assert.equal(customDetails.set_timeline[2].estimated_same_exercise_recovery_sec,268)
  assert(calls.includes('accounts:/_internal/mcp-owner'))
  assert(calls.includes('profile:'+uid+':/api/data'))
})

test('internal MCP profile selection accepts a non-owner single active user and rejects ambiguity', async () => {
  const {AccountDO} = await import('../src/accounts.js')
  const request = new Request('https://worker.invalid/_internal/mcp-owner')
  const one = {env:{},sql:{exec:()=>({toArray:()=>[{id:'user-without-owner-flag'}]})}}
  const success = await AccountDO.prototype.respond.call(one,request)
  assert.equal(success.status,200)
  assert.deepEqual(await success.json(),{id:'user-without-owner-flag'})
  for (const users of [[],[{id:'a'},{id:'b'}]]) {
    const mock={env:{},sql:{exec:()=>({toArray:()=>users})}}
    const failure=await AccountDO.prototype.respond.call(mock,request)
    assert.equal(failure.status,503)
  }
})
