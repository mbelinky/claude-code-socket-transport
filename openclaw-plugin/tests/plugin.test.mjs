import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import plugin from '../index.mjs';

const build=mkdtempSync(join(tmpdir(),'claude-plugin-build-'));
const binary=join(build,'claude-socket');
execFileSync('go',['build','-o',binary,'./cmd/claude-socket'],{cwd:resolve(import.meta.dirname,'../..')});
test.after(()=>rmSync(build,{recursive:true,force:true}));
async function fixture() {
 const peer=spawn('python3',['-B',join(import.meta.dirname,'peer.py')],{stdio:['pipe','pipe','inherit']});
 const lines=createInterface({input:peer.stdout});
 const [line]=await once(lines,'line');const info=JSON.parse(line);lines.close();
 const state=join(info.root,'plugin');
 const config={hosts:{local:{binary,configDir:info.profile,agents:['operator'],sessions:['*']}}};
 const ctx={agentId:'operator',sessionKey:'agent:operator:telegram:direct:test',assertInvocationCurrent(){}};
 let apiInstance;
 function load() {
  let factory,service;
  plugin.register({pluginConfig:config,runtime:{state:{resolveStateDir:()=>state}},registerTool(f){factory=f;},registerService(s){service=s;}});
  apiInstance={tools(c=ctx){return factory(c);},async call(name,args,c=ctx,signal){const tools=factory(c);const tool=tools?.find(t=>t.name===name);assert.ok(tool,`Tool ${name} unavailable`);const r=await tool.execute('call',args,signal);return JSON.parse(r.content[0].text);},stop:()=>service.stop()};
  return apiInstance;
 }
 const count=()=>{try{return readFileSync(join(info.root,'received'),'utf8').trim().split('\n').length}catch{return 0}};
 return {...info,state,config,ctx,load,count,async close(){await apiInstance?.stop();const done=once(peer,'exit');peer.stdin.end();await done;}};
}
const ask=(f,text='Reply ACK only')=>({host:'local',session_id:f.session,request_id:randomUUID(),text});

test('real CLI discovery and reply work without a channel adapter; restart suppresses duplicates',async()=>{
 const f=await fixture();let api=f.load();
 try {
  const listed=await api.call('claude_sessions_list',{});assert.equal(listed.sessions[0].session_id,f.session);assert.equal(listed.sessions[0].socket,undefined);
  const args=ask(f,"Reply ACK only; literal $(touch /tmp/should-not-exist) ' quote");
  const result=await api.call('claude_sessions_ask',args);assert.equal(result.status,'reply');assert.equal(result.text,'ACK');assert.equal(f.count(),1);
  await api.stop();api=f.load();
  const duplicate=await api.call('claude_sessions_ask',args);assert.equal(duplicate.status,'already_completed');assert.equal(f.count(),1);
  await assert.rejects(api.call('claude_sessions_ask',{...args,text:'changed'}),/reused/);
  await assert.rejects(api.call('claude_sessions_ask',args,{...f.ctx,sessionKey:'agent:operator:discord:other'}),/reused/);
  const other=await api.call('claude_sessions_ask',ask(f),{...f.ctx,sessionKey:'agent:operator:discord:other'});assert.equal(other.status,'reply');
 } finally {await f.close();}
});

test('host, caller, session, stale target and revoked invocation checks prevent sends',async()=>{
 const f=await fixture();const api=f.load();
 try {
  assert.equal(api.tools({...f.ctx,agentId:'stranger'}),null);
  await assert.rejects(api.call('claude_sessions_ask',{...ask(f),host:'unconfigured'}),/host/i);
  f.config.hosts.local.sessions=[randomUUID()];
  await assert.rejects(api.call('claude_sessions_ask',ask(f)),/session/i);
  assert.equal((await api.call('claude_sessions_list',{})).sessions.length,0);
  f.config.hosts.local.sessions=['*'];
  await assert.rejects(api.call('claude_sessions_ask',ask(f),{...f.ctx,assertInvocationCurrent(){throw Error('revoked')}}),/revoked/);
  const gone=await api.call('claude_sessions_ask',{...ask(f),session_id:randomUUID()});assert.equal(gone.status,'not_sent');
  assert.equal(f.count(),0);
 } finally {await f.close();}
});

test('concurrent duplicate calls send once; distinct calls retain reply correlation',async()=>{
 const f=await fixture();const api=f.load();
 try {
  const args=ask(f);const results=await Promise.all([api.call('claude_sessions_ask',args),api.call('claude_sessions_ask',args)]);
  assert.deepEqual(results.map(r=>r.status).sort(),['in_progress','reply']);assert.equal(f.count(),1);
  const pair=await Promise.all([api.call('claude_sessions_ask',ask(f)),api.call('claude_sessions_ask',ask(f))]);
  assert.ok(pair.every(r=>r.status==='reply'));assert.notEqual(pair[0].transport_request_id,pair[1].transport_request_id);assert.equal(f.count(),3);
 } finally {await f.close();}
});

test('refusal, timeout and cancellation preserve uncertainty and never resend after restart',async()=>{
 const f=await fixture();let api=f.load();
 try {
  writeFileSync(join(f.root,'mode'),'deny');assert.equal((await api.call('claude_sessions_ask',ask(f))).status,'refused');
  writeFileSync(join(f.root,'mode'),'hold');
  const args={...ask(f),timeout_seconds:1};assert.equal((await api.call('claude_sessions_ask',args)).status,'uncertain');
  await api.stop();api=f.load();assert.equal((await api.call('claude_sessions_ask',args)).status,'uncertain');assert.equal(f.count(),2);
  const controller=new AbortController();const pending=api.call('claude_sessions_ask',ask(f),f.ctx,controller.signal);
  for(let i=0;i<100 && f.count()<3;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(f.count(),3);controller.abort();assert.equal((await pending).status,'uncertain');
 } finally {await f.close();}
});

test('SSH arguments carry no message text; remote execution uses the same real CLI',async()=>{
 const f=await fixture();const oldPath=process.env.PATH;
 try {
  const bin=join(f.root,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'ssh'),`#!/usr/bin/env python3\nimport os,sys,shlex,json\nfrom pathlib import Path\nPath(${JSON.stringify(join(f.root,'ssh-args'))}).write_text(json.dumps(sys.argv))\na=shlex.split(sys.argv[-1]);os.execvp(a[0],a)\n`,{mode:0o700});
  process.env.PATH=bin+':'+oldPath;f.config.hosts.local.ssh='fixture-host';
  const api=f.load();const args=ask(f,"literal ' $(do-not-run) ; message");
  assert.equal((await api.call('claude_sessions_ask',args)).status,'reply');assert.equal(f.count(),1);
  assert.ok(!readFileSync(join(f.root,'ssh-args'),'utf8').includes(args.text));
 } finally {process.env.PATH=oldPath;await f.close();}
});
