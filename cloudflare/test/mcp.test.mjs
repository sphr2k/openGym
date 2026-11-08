import {test} from 'node:test'
import assert from 'node:assert/strict'
import appWorker from '../src/index.js'
import worker from '../src/mcp-worker.js'
import {withRemoteState, getState} from '../../mcp/src/state.js'

const url = 'https://staging.example/mcp'
const active = {MCP_UPSTREAM_TOKEN:'a'.repeat(64)}

test('main app does not expose MCP; dedicated worker only serves /mcp', async () => {
  const app = await appWorker.fetch(new Request(url), {}, {})
  const offPath = await worker.fetch(new Request('https://mcp.example/'), {}, {})
  assert.equal(app.status,404)
  assert.equal(offPath.status,404)
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
      return Response.json({state:{unit:'kg', workouts:[], routines:[{id:'r1',name:'My routine',ex:[]}],customEx:[]},rev:1})
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
