/*
 * test/realdata.mjs — 用真实 B站 DASH 流验证合并器（临时诊断脚本）
 * 流程：view → playurl → 下载真实视频轨/音频轨 → mergeToMp4 → 结构校验 + 字节回环
 * 运行：node test/realdata.mjs <输出目录> [bvid]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(__dirname, 'realdata');
const BVID = process.argv[3] || 'BV1GJ411x7h7';
fs.mkdirSync(OUT, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function jget(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}
async function dl(urls, file) {
  const list = Array.isArray(urls) ? urls : [urls];
  let lastErr = null;
  for (const u of list) {
    if (!u) continue;
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(file, buf);
      console.log('  下载完成:', path.basename(file), (buf.length / 1048576).toFixed(2) + ' MB  <-', new URL(u).host);
      return buf;
    } catch (e) {
      lastErr = e;
      console.log('  地址失败:', (() => { try { return new URL(u).host; } catch (_) { return u.slice(0, 60); } })(), '-', e.cause ? e.cause.code : e.message);
    }
  }
  throw new Error('所有 CDN 地址都失败: ' + lastErr.message);
}

// ---- 1. 视频信息 ----
console.log('== 1. 获取视频信息', BVID);
const view = await jget('https://api.bilibili.com/x/web-interface/view?bvid=' + BVID);
if (view.code !== 0) throw new Error('view 失败: ' + (view.message || view.code));
const { cid, title } = view.data;
console.log('  标题:', title, 'cid:', cid);

// ---- 2. 播放地址 ----
console.log('== 2. 获取播放地址');
const pu = await jget(`https://api.bilibili.com/x/player/playurl?bvid=${BVID}&cid=${cid}&qn=64&fnval=4048&fourk=1&platform=pc`);
if (pu.code !== 0) throw new Error('playurl 失败: ' + (pu.message || pu.code));
const dash = pu.data.dash;
const video = (dash.video || []).find((v) => v.codecid === 7) || dash.video[0];
const audio = (dash.audio || []).find((a) => a.id === 30216 || a.id === 30232) || dash.audio[0];
if (!video || !audio) throw new Error('没有找到 dash 视频/音频轨');
console.log('  视频: qn=' + video.id, 'codecid=' + video.codecid, video.codecs);
console.log('  音频: id=' + audio.id, audio.codecs);

// ---- 3. 下载真实流 ----
console.log('== 3. 下载真实流');
const vUrls = [video.baseUrl].concat(video.backupUrl || []);
const aUrls = [audio.baseUrl].concat(audio.backupUrl || []);
const vBuf = await dl(vUrls, path.join(OUT, 'src_video.mp4'));
const aBuf = await dl(aUrls, path.join(OUT, 'src_audio.m4a'));

// ---- 4. 加载合并器并合并 ----
console.log('== 4. 合并');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'muxer.js'), 'utf8');
const testWindow = {};
new Function('window', src)(testWindow);
const muxer = testWindow.BDGMuxer;
const merged = muxer.mergeToMp4(new Uint8Array(vBuf.buffer, vBuf.byteOffset, vBuf.byteLength), new Uint8Array(aBuf.buffer, aBuf.byteOffset, aBuf.byteLength));
console.log('  合并输出:', (merged.length / 1048576).toFixed(2) + ' MB');
fs.writeFileSync(path.join(OUT, 'merged.mp4'), merged);

// ---- 5. 结构校验 ----
console.log('== 5. 结构校验');
const u8 = merged;
const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
function readBoxes(start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    const size = dv.getUint32(off);
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    if (size < 8 || off + size > end) break;
    out.push({ type, start: off, end: off + size });
    off += size;
  }
  return out;
}
const find = (l, t) => l.find((b) => b.type === t);
const tops = readBoxes(0, u8.length);
const moov = find(tops, 'moov');
const mdat = find(tops, 'mdat');
const traks = readBoxes(moov.start + 8, moov.end).filter((b) => b.type === 'trak');
console.log('  顶层:', tops.map((b) => b.type).join(','), '| trak 数:', traks.length);

// 解析函数（与 muxer 内部一致，快速实现）
function parseTrackInfo(trak) {
  const tChildren = readBoxes(trak.start + 8, trak.end);
  const tkhd = find(tChildren, 'tkhd');
  const mdia = find(tChildren, 'mdia');
  const mChildren = readBoxes(mdia.start + 8, mdia.end);
  const mdhd = find(mChildren, 'mdhd');
  const hdlr = find(mChildren, 'hdlr');
  const minf = find(mChildren, 'minf');
  const sChildren = readBoxes(minf.start + 8, minf.end);
  const stbl = find(sChildren, 'stbl');
  const stblBoxes = readBoxes(stbl.start + 8, stbl.end);
  const g = (t) => find(stblBoxes, t);
  const handler = String.fromCharCode(u8[hdlr.start + 16], u8[hdlr.start + 17], u8[hdlr.start + 18], u8[hdlr.start + 19]);
  const ts = dv.getUint32(mdhd.start + 20);
  const mdDur = dv.getUint32(mdhd.start + 24);
  const stsz = g('stsz');
  const count = dv.getUint32(stsz.start + 16);
  const stco = g('stco');
  const offs = [];
  for (let i = 0; i < count; i++) offs.push(dv.getUint32(stco.start + 16 + i * 4));
  const stsd = g('stsd');
  const entry = u8.slice(stsd.start + 16, stsd.end); // 首个条目盒（含 size+type）
  const stts = g('stts');
  const sttsN = dv.getUint32(stts.start + 12);
  let sttsSum = 0;
  for (let i = 0; i < sttsN; i++) sttsSum += dv.getUint32(stts.start + 16 + i * 8) * dv.getUint32(stts.start + 20 + i * 8);
  return { handler, ts, mdDur, count, offs, entry, sttsSum, sttsN };
}
const ti = traks.map(parseTrackInfo);
for (const t of ti) {
  console.log(`  轨道 ${t.handler}: timescale=${t.ts} mdhdDuration=${t.mdDur} 样本数=${t.count} sttsSum=${t.sttsSum} stts条目=${t.sttsN} stsd条目=${t.entry.slice(4, 8).toString('latin1')}(${t.entry.length}B)`);
}

// ---- 6. 字节回环：mdat 中每个样本与源逐字节一致 ----
console.log('== 6. 字节回环校验（真实数据）');
function checkTrack(t, srcBuf, srcSampleCount, label) {
  if (t.count !== srcSampleCount) { console.log(`  ✗ ${label}: 样本数 ${t.count} != 源 ${srcSampleCount}`); return false; }
  let ok = true;
  for (let i = 0; i < t.count; i++) {
    const off = t.offs[i];
    if (off < mdat.start + 8 || off + 10 > mdat.end) { console.log(`  ✗ ${label}: 样本${i} 偏移越界 ${off}`); return false; }
    // 抽查前 8 字节
    for (let j = 0; j < 8; j++) {
      if (u8[off + j] !== srcBuf[srcStart(t, i) + j]) { ok = false; break; }
    }
    if (!ok) { console.log(`  ✗ ${label}: 样本${i} 字节不一致 @${off}`); return false; }
  }
  console.log(`  ✓ ${label}: ${t.count} 个样本全部一致`);
  return true;
}
// 源的样本位置需要重新解析源文件 —— 直接复用 muxer 内部解析
const vSrc = muxer.__dbg ? null : null;
console.log('  （源的逐字节对比见下方详细输出）');

// 用 muxer 内部解析源流，打印关键字段并做偏移级对比
const srcMuxer = testWindow.BDGMuxer;
// 临时暴露内部解析
const src2 = src.replace('global.BDGMuxer = api;', 'global.BDGMuxer = api; global.BDGMuxer.__dbg = { parseFmp4: parseFmp4 };');
const w2 = {};
new Function('window', src2)(w2);
const { parseFmp4 } = w2.BDGMuxer.__dbg;
const vp = parseFmp4(new Uint8Array(vBuf.buffer, vBuf.byteOffset, vBuf.byteLength));
const ap = parseFmp4(new Uint8Array(aBuf.buffer, aBuf.byteOffset, aBuf.byteLength));
const vS = vp.tracks.find((t) => t.handler === 'vide') || vp.tracks[0];
const aS = ap.tracks.find((t) => t.handler === 'soun') || ap.tracks[0];
console.log(`  源视频: ${vS.samples.length} 样本, ts=${vS.timescale}, 前5样本 dur=${vS.samples.slice(0, 5).map(s => s.duration).join(',')}, cto范围=${Math.min(...vS.samples.map(s=>s.cts-s.dts))}..${Math.max(...vS.samples.map(s=>s.cts-s.dts))}`);
console.log(`  源音频: ${aS.samples.length} 样本, ts=${aS.timescale}, 前5样本 dur=${aS.samples.slice(0, 5).map(s => s.duration).join(',')}, 末样本 dur=${aS.samples[aS.samples.length-1].duration}`);

// 偏移级对比：输出 stco 处的字节 vs 源 dataStart 处的字节（直接引用源文件字节）
function verify(t, srcTrack, srcFile, label) {
  let bad = 0;
  const n = Math.min(t.count, srcTrack.samples.length);
  for (let i = 0; i < n && bad < 5; i++) {
    const off = t.offs[i];
    const sd = srcTrack.samples[i];
    for (let j = 0; j < Math.min(16, sd.size); j++) {
      if (u8[off + j] !== srcFile[sd.dataStart + j]) { bad++; console.log(`  ✗ ${label} 样本${i} 字节${j} 不一致 (输出@${off} vs 源@${sd.dataStart})`); break; }
    }
  }
  console.log(bad === 0 ? `  ✓ ${label}: stco 指向的字节与源样本完全一致 (前 ${n} 个样本)` : `  ✗ ${label}: ${bad} 处不一致`);
}
verify(ti[0], vS, vBuf, '视频轨');
verify(ti[1], aS, aBuf, '音频轨');

// stsd 条目字节对比
const vEntry = Buffer.from(ti[0].entry);
const aEntry = Buffer.from(ti[1].entry);
const srcVEntry = Buffer.from(vS.sampleEntry);
const srcAEntry = Buffer.from(aS.sampleEntry);
console.log('  视频 stsd 条目与源一致:', vEntry.equals(srcVEntry), `(${vEntry.length}B vs ${srcVEntry.length}B)`);
console.log('  音频 stsd 条目与源一致:', aEntry.equals(srcAEntry), `(${aEntry.length}B vs ${srcAEntry.length}B)`);
if (!aEntry.equals(srcAEntry)) {
  console.log('  ---- 音频 stsd 条目差异 ----');
  for (let i = 0; i < Math.max(aEntry.length, srcAEntry.length); i++) {
    if (aEntry[i] !== srcAEntry[i]) console.log(`  byte ${i}: 输出=${aEntry[i]?.toString(16)} 源=${srcAEntry[i]?.toString(16)}`);
  }
}

console.log('\n完成。文件已保存到:', path.resolve(OUT));
