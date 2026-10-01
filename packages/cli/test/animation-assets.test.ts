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
