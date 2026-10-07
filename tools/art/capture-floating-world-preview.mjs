// Isolated local-file art review. No game server, game saves, or production URL.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const out=path.join(root,'docs/Art/floating-world-v1')
const pack=path.join(root,'public/art/floating-world-v1')
const candidates=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe',path.join(process.env.LOCALAPPDATA||'','Google/Chrome/Application/chrome.exe')]
const browser=candidates.find(file=>fs.existsSync(file))
if(!browser)throw new Error('No local Edge/Chrome available for the art-only capture')
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'voxal-art-'))
const child=spawn(browser,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--use-angle=swiftshader','--enable-unsafe-swiftshader','--hide-scrollbars','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'})
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
let ws
try {
  const portFile=path.join(profile,'DevToolsActivePort')
  const deadline=Date.now()+15000
  while(!fs.existsSync(portFile)) {if(Date.now()>deadline)throw new Error('Browser startup timeout');await delay(100)}
  const port=fs.readFileSync(portFile,'utf8').split(/\r?\n/)[0]
  const target=await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json()
  ws=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
  let serial=0
  const pending=new Map()
  ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(!message.id)return;const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(new Error(JSON.stringify(message.error))):entry.resolve(message.result)})
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`))},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})
  await send('Page.enable');await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  const pageUrl=pathToFileURL(path.join(out,'asset-preview.html')).href
  const ready=async()=>{
    const response=await send('Runtime.evaluate',{expression:`new Promise((resolve,reject)=>{let n=0;const id=setInterval(()=>{if(window.__artError){clearInterval(id);reject(new Error(window.__artError))}else if(window.__artReady){clearInterval(id);resolve(window.__artStats)}else if(++n>400){clearInterval(id);reject(new Error('art readiness timeout'))}},25)})`,awaitPromise:true,returnByValue:true})
    if(response.exceptionDetails)throw new Error(JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  await send('Page.navigate',{url:pageUrl+'?still=1'})
  await delay(150)
  const staticStats=await ready()
  const clouds=(await send('Runtime.evaluate',{expression:'window.__cloudPngs',returnByValue:true})).result.value
  for(const name of ['cloud-a','cloud-b','cloud-c']) {
    if(!clouds[name]?.startsWith('data:image/png;base64,'))throw new Error(`Missing cloud export ${name}`)
    fs.writeFileSync(path.join(pack,'clouds',name+'.png'),Buffer.from(clouds[name].split(',')[1],'base64'))
  }
  const metrics=await send('Page.getLayoutMetrics')
  const height=Math.ceil(metrics.cssContentSize.height)
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:1440,height,scale:1}})
  fs.writeFileSync(path.join(out,'asset-contact-sheet.png'),Buffer.from(shot.data,'base64'))
  await send('Page.navigate',{url:pageUrl})
  await delay(150)
  await ready()
  const first=(await send('Runtime.evaluate',{expression:'window.__artStats',returnByValue:true})).result.value
  await delay(500)
  const second=(await send('Runtime.evaluate',{expression:'window.__artStats',returnByValue:true})).result.value
  if(!(second.time>first.time))throw new Error('Ambient clock did not advance in the visible preview')
  if(second.boardCells!==98||second.models!==3||second.clouds!==3)throw new Error('Art-only scene inventory mismatch')
  const report={scope:'isolated art preview, NOT game integration or physical-device QA',viewport:{width:1440,height},staticStats,animation:{timeBefore:first.time,timeAfter:second.time,cloudXBefore:first.cloudX,cloudXAfter:second.cloudX},cloudPngExports:Object.keys(clouds),browser:path.basename(browser)}
  fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify(report,null,2)+'\n')
  // Refresh the manifest to include the just-rasterized cloud alternatives.
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(path.join(dir,item.name)):[path.join(dir,item.name)])
  const manifest=JSON.parse(fs.readFileSync(path.join(pack,'manifest.json'),'utf8'))
  const all=walk(pack).filter(file=>path.basename(file)!=='manifest.json').sort()
  const old=new Map(manifest.files.map(item=>[item.path,item]))
  manifest.files=all.map(file=>{const rel=path.relative(pack,file).replaceAll('\\','/');return {...old.get(rel),path:rel,bytes:fs.statSync(file).size,role:rel.split('/')[0]}})
  manifest.totals={files:all.length,bytes:all.reduce((n,file)=>n+fs.statSync(file).size,0)}
  fs.writeFileSync(path.join(pack,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
  console.log(JSON.stringify(report))
  await send('Browser.close').catch(()=>{})
} finally {
  ws?.close()
  if(child.exitCode===null) {
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(2000)])
    if(child.exitCode===null)child.kill()
  }
  try{fs.rmSync(profile,{recursive:true,force:true})}catch{}
}
