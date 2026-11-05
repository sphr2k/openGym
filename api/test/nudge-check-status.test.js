import { test } from "node:test";
import assert from "node:assert/strict";
import { nudgeCheckStatus, validNudgeDate } from "../nudge-check-status.js";

const allDays = {0:"push",1:"push",2:"push",3:"push",4:"push",5:"push",6:"push"};
const profile = {
  workouts:[{id:"w",d:"2026-09-14",name:"Private secret session",entries:[{id:"bench"}]}],
  routines:[{id:"push",name:"Push Day"}],week:allDays,dayPlan:{},
  dayNotes:{"2026-09-15":{tag:"sick",_ts:1},"2026-09-16":{_ts:2}},
  reminder:{on:true,nudge:true,time:"08:00"}
};
test("shared nudge-check only exposes date/done/nudge/revision",()=>{
  assert.deepEqual(nudgeCheckStatus(profile,"2026-09-14",7),
    {date:"2026-09-14",done:true,nudge:false,rev:7});
  assert.deepEqual(nudgeCheckStatus(profile,"2026-09-15",7),
    {date:"2026-09-15",done:true,nudge:false,rev:7});
  assert.deepEqual(nudgeCheckStatus(profile,"2026-09-16",7),
    {date:"2026-09-16",done:false,nudge:true,rev:7});
  assert.deepEqual(nudgeCheckStatus({}, "2026-09-14", 0),
    {date:"2026-09-14",done:false,nudge:false,rev:0});
});
test("Node and Cloudflare date gates share original date-validation behavior",()=>{
  for(const date of ["","today","2026-9-14","2026-13-45","2026-09-14T00:00"])
    assert.equal(validNudgeDate(date),false,date);
  assert.equal(validNudgeDate("2026-09-14"),true);
});
