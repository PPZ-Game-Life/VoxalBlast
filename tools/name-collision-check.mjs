#!/usr/bin/env node
/**
 * 命名撞名检索：把"这个名字有没有人占"从感觉变成可复现的三次查询。
 *
 * 用法：
 *   node tools/name-collision-check.mjs "Cube Blaster" Blockface
 *
 * 覆盖：
 *   1) CrazyGames 站内占位（/game/<slug> 探针，200 = 已占位，404 = 干净）
 *   2) App Store（iTunes 公开 Search API）
 *   3) Steam（公开 storesearch API）
 *
 * 不覆盖（必须人工看，脚本不假装能查）：
 *   - Y8 / Poki / Playgama 等 Web 小游戏门户（无公开检索 API）
 *   - Google Play（搜索页是 JS 渲染，无公开 API）
 *   - 商标库（USPTO TESS / EUIPO）与域名
 *
 * 约定：只做只读查询，不写文件、不改仓库；同名多次只查一次。
 */

const CANDIDATES = process.argv.slice(2);
if (CANDIDATES.length === 0) {
  console.error('用法: node tools/name-collision-check.mjs "Name One" "Name Two"');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function fetchWithRetry(url, init = {}, tries = 3) {
  for (let i = 1; i <= tries; i += 1) {
    try {
      return await fetch(url, { ...init, headers: { 'user-agent': UA, ...(init.headers || {}) } });
    } catch (err) {
      if (i === tries) return { error: err.message };
      await sleep(800 * i);
    }
  }
}

function slugsFor(name) {
  const base = name.toLowerCase().trim().replace(/\s+/g, '-');
  return [...new Set([base, base.replace(/-/g, ''), `${base}-3d`])];
}

async function checkCrazyGames(name) {
  const out = [];
  for (const slug of slugsFor(name)) {
    const res = await fetchWithRetry(`https://www.crazygames.com/game/${slug}`, { method: 'GET' });
    if (res.error) out.push(`${slug}: ERR`);
    else out.push(`${slug}: ${res.status === 200 ? 'TAKEN' : res.status}`);
    await sleep(400);
  }
  return out.join('  |  ');
}

async function checkITunes(name) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=software&limit=20&country=us`;
  const res = await fetchWithRetry(url);
  if (res.error) return `ERR (${res.error})`;
  const json = await res.json().catch(() => null);
  if (!json) return 'ERR (bad json)';
  const target = norm(name);
  const exact = json.results.filter((r) => norm(r.trackName || '') === target);
  const near = json.results.filter((r) => norm(r.trackName || '').startsWith(target.slice(0, 8)));
  const sample = near.slice(0, 4).map((r) => r.trackName).join(' / ') || '—';
  return `${json.resultCount} hits, 同名 ${exact.length} (${exact.map((r) => r.trackName).join(', ') || '无'}) | 近似: ${sample}`;
}

async function checkSteam(name) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&cc=us&l=english`;
  const res = await fetchWithRetry(url);
  if (res.error) return `ERR (${res.error})`;
  const json = await res.json().catch(() => null);
  if (!json) return 'ERR (bad json)';
  const target = norm(name);
  const items = json.items || [];
  const exact = items.filter((i) => norm(i.name || '') === target);
  return `${json.total} hits, 同名 ${exact.length} (${exact.map((i) => `${i.name} id${i.id}`).join(', ') || '无'})`;
}

for (const name of CANDIDATES) {
  console.log(`\n=== ${name}`);
  console.log(`CrazyGames  : ${await checkCrazyGames(name)}`);
  console.log(`App Store   : ${await checkITunes(name)}`);
  console.log(`Steam       : ${await checkSteam(name)}`);
}

console.log('\n人工必查（脚本覆盖不到）：Y8 / Poki / Playgama；Google Play 搜索页；USPTO TESS 与 EUIPO 同名同类商标；<name>.com / .io 域名。');
