import {execFileSync, spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';

const setup = join(import.meta.dirname, '../src/skills/splicewright-animation/scripts/setup_engine.py');
const run = (cwd: string, engine: string, dir: string) => spawnSync('python3', [setup, engine, '--dir', dir], {cwd, encoding:'utf8'});

it('scaffolds isolated engines and preserves authored scenes on rerun', () => {
  const cwd = mkdtempSync(join(tmpdir(),'swr-engines-'));
  expect(run(cwd,'motion-canvas','animations/motion-canvas').status).toBe(0);
  const manifest = JSON.parse(readFileSync(join(cwd,'animations/motion-canvas/package.json'),'utf8'));
  expect(manifest.dependencies['@motion-canvas/core']).toBe('3.17.2');
  expect(existsSync(join(cwd,'animations/motion-canvas/src/scenes.d.ts'))).toBe(true);
  expect(run(cwd,'manim','animations/manim').status).toBe(0);
  const scene = join(cwd,'animations/manim/scene.py');
  writeFileSync(scene,'# my authored scene\n');
  expect(run(cwd,'manim','animations/manim').status).toBe(0);
  expect(readFileSync(scene,'utf8')).toBe('# my authored scene\n');
  expect(existsSync(join(cwd,'animations/manim/.venv'))).toBe(false);
  expect(existsSync(join(cwd,'project.json'))).toBe(false);
});

it('rejects destination traversal and refuses to write through a symlink before copying', () => {
  const cwd = mkdtempSync(join(tmpdir(),'swr-engine-path-'));
  const outside = mkdtempSync(join(tmpdir(),'swr-engine-outside-'));
  expect(run(cwd,'manim','../escape').status).not.toBe(0);
  expect(run(cwd,'manim',outside).status).not.toBe(0);
  expect(run(cwd,'manim','raw/scenes').status).not.toBe(0);
  const target=join(cwd,'animations/motion-canvas');
  mkdirSync(target,{recursive:true});
  symlinkSync(outside,join(target,'src'),'dir');
  expect(run(cwd,'motion-canvas','animations/motion-canvas').status).not.toBe(0);
  expect(existsSync(join(outside,'scene.tsx'))).toBe(false);
  expect(existsSync(join(target,'package.json'))).toBe(false);
});

it('agent render bridge refuses cross-origin and malformed rendering requests', () => {
  const cwd=mkdtempSync(join(tmpdir(),'swr-render-bridge-'));
  copyFileSync(join(import.meta.dirname,'../src/skills/splicewright-animation/assets/motion-canvas/agent-bridge.ts.template'),join(cwd,'bridge.ts'));
  const probe = `
    import {agentBridge} from './bridge.ts';
    const hooks={}; let middleware;
    agentBridge().configureServer({
      ws:{on:(name,fn)=>hooks[name]=fn,send:()=>{throw new Error('invalid request reached browser')}},
      httpServer:{on:()=>{}},config:{logger:{info:()=>{}}},middlewares:{use:fn=>middleware=fn}
    });
    async function request(body,origin='http://127.0.0.1:9000',host='127.0.0.1:9000') {
      let code;
      const req={url:'/__splicewright/render',method:'POST',headers:{host,origin},socket:{remoteAddress:'127.0.0.1'},
        async *[Symbol.asyncIterator](){yield Buffer.from(body)}};
      await middleware(req,{writeHead(value){code=value},end(){}},()=>{throw new Error('route fell through')});
      return code;
    }
    const valid=JSON.stringify({fps:30,width:1920,height:1080});
    console.log(JSON.stringify([
      await request(valid,'https://untrusted.example'),
      await request(valid,'http://evil.example:9000','evil.example:9000'),
      await request('{'),await request('null'),
      await request(JSON.stringify({fps:0,width:1920,height:1080})),
      await request(JSON.stringify({fps:30,width:1920,height:1080,path:'../outside'})),
      await request(' '.repeat(1025))
    ]));
  `;
  expect(JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',probe],{cwd,encoding:'utf8'})))
    .toEqual([403,403,400,400,400,400,413]);
});

it('agent render bridge asks only the newest live tab and tracks a render the browser accepts after the timeout', {timeout:20000}, () => {
  const cwd=mkdtempSync(join(tmpdir(),'swr-render-bridge-tabs-'));
  copyFileSync(join(import.meta.dirname,'../src/skills/splicewright-animation/assets/motion-canvas/agent-bridge.ts.template'),join(cwd,'bridge.ts'));
  const probe = `
    import {readFileSync} from 'node:fs';
    import {agentBridge} from './bridge.ts';
    const hooks={}, clients=new Set(); let middleware;
    const tab=()=>({sent:[],send(event,payload){this.sent.push({event,payload});}});
    agentBridge().configureServer({
      ws:{on:(name,fn)=>hooks[name]=fn,clients,send:()=>{throw new Error('broadcast reached every tab')}},
      httpServer:{on:()=>{}},config:{logger:{info:()=>{}}},middlewares:{use:fn=>middleware=fn}
    });
    async function call(method,url,body='') {
      let code,payload;
      const req={url,method,headers:{host:'127.0.0.1:9000'},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){yield Buffer.from(body)}};
      await middleware(req,{writeHead(value){code=value},end(data){payload=JSON.parse(data)}},()=>{throw new Error('route fell through')});
      return [code,payload];
    }
    const answer=(tab,extra)=>hooks['splicewright:response']({id:tab.sent.at(-1).payload.id,...extra});
    const a=tab(), b=tab(); clients.add(a); clients.add(b);
    const out={};
    out.noHello=(await call('GET','/__splicewright/status'))[0];
    hooks['splicewright:hello']({},a); hooks['splicewright:hello']({},b);
    const first=call('GET','/__splicewright/status');
    out.newestOnly=[a.sent.length,b.sent.length];
    answer(b,{ready:true}); out.newestAnswered=(await first)[0];
    clients.delete(b); // the newest tab closed: fall back to the older one
    const second=call('GET','/__splicewright/status');
    out.fallback=[a.sent.length,b.sent.length];
    answer(a,{ready:true}); await second;
    const render=call('POST','/__splicewright/render',JSON.stringify({fps:30,width:1280,height:720}));
    await new Promise(done=>setImmediate(done)); // the body is read before the browser is asked
    const id=a.sent.at(-1).payload.id;
    const [code,timedOut]=await render; // nobody answers within the 2 s window
    out.timeout=[code,timedOut.id===id];
    const state=()=>JSON.parse(readFileSync('.agent-render/'+id+'.json','utf8')).state;
    out.awaiting=state(); // the file the 503 points at already exists
    hooks['splicewright:response']({id,accepted:true}); // ...then the browser accepts it anyway
    out.late=state();
    hooks['splicewright:done']({id,state:'complete'});
    out.done=state();
    console.log(JSON.stringify(out));
  `;
  expect(JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',probe],{cwd,encoding:'utf8'})))
    .toEqual({noHello:503,newestOnly:[0,1],newestAnswered:200,fallback:[1,1],timeout:[503,true],awaiting:'awaiting-acceptance',late:'running',done:'complete'});
});

it('agent render bridge runs one render at a time across tabs, and frees it on done, rejection or a closed tab', {timeout:20000}, () => {
  const cwd=mkdtempSync(join(tmpdir(),'swr-render-bridge-one-'));
  copyFileSync(join(import.meta.dirname,'../src/skills/splicewright-animation/assets/motion-canvas/agent-bridge.ts.template'),join(cwd,'bridge.ts'));
  const probe = `
    import {readFileSync} from 'node:fs';
    import {agentBridge} from './bridge.ts';
    const hooks={}, clients=new Set(); let middleware;
    const tab=()=>({sent:[],send(event,payload){this.sent.push(payload);}});
    agentBridge().configureServer({
      ws:{on:(name,fn)=>hooks[name]=fn,clients,send:()=>{}},
      httpServer:{on:()=>{}},config:{logger:{info:()=>{}}},middlewares:{use:fn=>middleware=fn}
    });
    // POST /render; the tab asked (if any) answers at once with \`reply\`; resolves to [status, body, id]
    async function render(reply,...tabs) {
      let code,payload;
      const req={url:'/__splicewright/render',method:'POST',headers:{host:'127.0.0.1:9000'},socket:{remoteAddress:'127.0.0.1'},
        async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({fps:30,width:1280,height:720}))}};
      const done=middleware(req,{writeHead(value){code=value},end(data){payload=JSON.parse(data)}},()=>{throw new Error('fell through')});
      await new Promise(r=>setImmediate(r));
      const asked=tabs.find(t=>t.sent.length>t.seen);
      if (asked) {asked.seen=asked.sent.length;hooks['splicewright:response']({id:asked.sent.at(-1).id,...reply});}
      await done; return [code,payload,asked?asked.sent.at(-1).id:payload.id];
    }
    const file=(id)=>JSON.parse(readFileSync('.agent-render/'+id+'.json','utf8')).state;
    const a=tab(), b=tab(); a.seen=b.seen=0; clients.add(a); clients.add(b);
    const out={};
    hooks['splicewright:hello']({},a);
    const [c1,,id1]=await render({accepted:true},a,b); out.first=[c1,file(id1)];
    hooks['splicewright:hello']({},b); // another tab becomes the newest while render 1 runs
    const [c2,body2]=await render({accepted:true},a,b);
    out.second=[c2,body2.id===id1,b.sent.length]; // refused, names the running job, and b was never asked
    hooks['splicewright:done']({id:id1,state:'complete'});
    const [c3,,id3]=await render({error:'render already running'},a,b); // b refuses it
    out.rejected=[c3,file(id3)];
    const [c4,,id4]=await render({accepted:true},a,b); // a refusal frees the bridge
    out.afterRejected=[c4,file(id4)];
    clients.delete(b); // the tab that owns render 4 closes
    const [c5,,id5]=await render({accepted:true},a,b);
    out.afterClosed=[c5,file(id4),file(id5)];
    console.log(JSON.stringify(out));
  `;
  expect(JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',probe],{cwd,encoding:'utf8'})))
    .toEqual({first:[202,'running'],second:[409,true,0],rejected:[503,'rejected'],afterRejected:[202,'running'],afterClosed:[202,'failed','running']});
});

it('agent render client refuses a request while the renderer is busy or the request expired, and never credits another render to it', {timeout:20000}, () => {
  const cwd=mkdtempSync(join(tmpdir(),'swr-render-client-'));
  const template=readFileSync(join(import.meta.dirname,'../src/skills/splicewright-animation/assets/motion-canvas/src/agent-client.ts.template'),'utf8');
  writeFileSync(join(cwd,'client.ts'),template.replace(/^import .*@motion-canvas\/core';$/m,"import {RendererResult,RendererState,Vector2} from './core.ts';").replaceAll('import.meta.hot','globalThis.hot'));
  writeFileSync(join(cwd,'core.ts'),'export const RendererResult={Success:0,Error:1,Aborted:2}; export const RendererState={Initial:0,Working:1,Aborting:2}; export class Vector2{x=0;y=0;constructor(x:number,y:number){this.x=x;this.y=y;}}');
  const probe = `
    import {agentClient} from './client.ts';
    const sent=[], handlers={}; let finished, rendered=0;
    globalThis.hot={send:(event,data)=>sent.push([event,data]),on:(event,fn)=>handlers[event]=fn};
    const plugin=agentClient();
    plugin.project({name:'p',meta:{getFullRenderingSettings:()=>({})}});
    const renderer={state:0,onFinished:{subscribe:fn=>finished=fn},onStateChanged:{get current(){return renderer.state}},render:async()=>{rendered++}};
    plugin.renderer(renderer);
    const ask=async(id,extra={})=>{
      await handlers['splicewright:request']({id,action:'render',expires:Date.now()+1000,fps:30,width:1280,height:720,...extra});
      return sent.filter(([event,data])=>event==='splicewright:response'&&data.id===id).map(([,data])=>data.error??(data.accepted?'accepted':'?'));
    };
    const out={};
    renderer.state=1; // a render started from the editor UI
    out.busy=await ask('a'); finished(0); // ...and finishes
    out.busyDone=sent.some(([event])=>event==='splicewright:done'); out.busyRendered=rendered;
    renderer.state=0;
    out.expired=await ask('b',{expires:Date.now()-1}); out.expiredRendered=rendered;
    out.ok=await ask('c'); out.okRendered=rendered;
    console.log(JSON.stringify(out));
  `;
  expect(JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',probe],{cwd,encoding:'utf8'})))
    .toEqual({busy:['the Motion Canvas renderer is busy'],busyDone:false,busyRendered:0,expired:['request expired'],expiredRendered:0,ok:['accepted'],okRendered:1});
});
