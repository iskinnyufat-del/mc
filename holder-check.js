// holder-check.js
// 作用：统一“是否持币 + 次数配置”
// - 发币前：用 Firestore 的 config/draw（和可选的 whitelist/{address}）决定
// - 发币后：优先走链上余额（根据 index.html 传入的 CHAIN 配置）
// ⭐ 增强：多 RPC 回退 + 超时；403/-32052 自动切换到其他公共 RPC

/* =========================
 * 远程配置：config/draw
 * ========================= */
export async function loadRemoteConfig(db, { defaults } = {}) {
  const fallback = defaults || {
    forceAllAsHolder: false,
    holderChances: 3,
    nonHolderChances: 1
  };
  try {
    const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore-lite.js");
    const ref = doc(db, 'config', 'draw');
    const snap = await getDoc(ref);
    if (!snap.exists()) return { ...fallback };
    const d = snap.data() || {};
    return {
      forceAllAsHolder: typeof d.forceAllAsHolder === 'boolean' ? d.forceAllAsHolder : fallback.forceAllAsHolder,
      holderChances: typeof d.holderChances === 'number' ? d.holderChances : fallback.holderChances,
      nonHolderChances: typeof d.nonHolderChances === 'number' ? d.nonHolderChances : fallback.nonHolderChances,
    };
  } catch (e) {
    console.warn('[holder-check] loadRemoteConfig failed, use defaults:', e);
    return { ...fallback };
  }
}

/* =========================
 * 可选白名单：whitelist/{wallet}
 * ========================= */
async function isWhitelisted(db, address) {
  try {
    const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore-lite.js");
    const ref = doc(db, 'whitelist', address);
    const snap = await getDoc(ref);
    return !!(snap.exists() && snap.data()?.holder === true);
  } catch {
    return false;
  }
}

/* =========================
 * 工具：RPC 选择与超时保护
 * ========================= */
function dedupe(arr) {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = (x || '').trim(); if (k && !seen.has(k)) { seen.add(k); out.push(k); } }
  return out;
}

// 浏览器里常见的 403（CORS/需要 API Key），准备一组公共可用 RPC 做回退
function buildRpcList(chainConfig) {
  const primary = (chainConfig?.rpcEndpoint || '').trim();

  // 你可以在这里把自有 Key 的 Helius/Alchemy 加进去（带 ?api-key=xxx）
  const fallbacks = [
    // 无需 Key 的公共节点（CORS 友好）
    'https://solana.publicnode.com',
    'https://rpc.ankr.com/solana',
    'https://solana-rpc.publicnode.com',
  ];

  // 如果 primary 是官方 api.mainnet-beta，优先把它放到队尾（很多场景会 403）
  const list = [];
  if (primary && !/api\.mainnet-beta\.solana\.com/i.test(primary)) list.push(primary);
  list.push(...fallbacks);
  // 最后再把官方加上（以防某些环境可用）
  if (primary && /api\.mainnet-beta\.solana\.com/i.test(primary)) list.push(primary);

  return dedupe(list);
}

function withTimeout(promise, ms = 2000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('rpc-timeout')), ms))
  ]);
}

function isApiKeyError(e) {
  const msg = String(e?.message || e || '');
  return /-32052|api key|forbidden|403/i.test(msg);
}

/* =========================
 * 链上余额检查：任一 mint 满足阈值即算 holder
 * ========================= */
async function checkAnyMintHold({ owner, chainConfig }) {
  const { commitment, mints } = chainConfig || {};
  if (!Array.isArray(mints) || mints.length === 0) return null;

  if (typeof window === 'undefined' || !window.solanaWeb3) {
    console.warn('[holder-check] solanaWeb3 not present, skip on-chain');
    return null;
  }

  const { Connection, PublicKey } = window.solanaWeb3;
  const ownerPk = new PublicKey(owner);

  const endpoints = buildRpcList(chainConfig);
  let lastErr = null;

  // 逐个 RPC 尝试，遇到 403/需 API Key 自动切换到下一条
  for (const rpc of endpoints) {
    try {
      const connection = new Connection(rpc, commitment || "confirmed");

      // 对每个 mint 读取 ATA 聚合余额（带超时）
      for (const mint of mints) {
        if (!mint?.address) continue;
        const mintPk = new PublicKey(mint.address);
        const programId = mint.tokenProgram ? new PublicKey(mint.tokenProgram) : undefined;

        const resp = await withTimeout(
          connection.getParsedTokenAccountsByOwner(
            ownerPk,
            { mint: mintPk, ...(programId ? { programId } : {}) }
          ),
          2000
        );

        let total = 0;
        for (const { account } of resp.value) {
          const ui = Number(account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
          total += ui;
        }
        const threshold = Number(mint.minHoldUiAmount ?? 1e-9);
        if (total > threshold) {
          return { ok: true, mint: mint.address, amount: total, rpcUsed: rpc };
        }
      }
      // 该 RPC 成功但没持仓，尝试完所有 mint 也没命中 → 直接返回 false
      return { ok: false, rpcUsed: rpc };
    } catch (e) {
      lastErr = e;
      // API Key / 403 错误：切换到下一条 RPC
      if (isApiKeyError(e)) {
        console.warn(`[holder-check] RPC requires API key or forbidden, switch: ${rpc}`, e);
        continue;
      }
      // 其他错误也继续尝试下一条
      console.warn(`[holder-check] RPC error, switch next: ${rpc}`, e);
      continue;
    }
  }

  // 所有 RPC 都失败了：返回 null 让上层走 fallback
  if (lastErr) {
    console.warn('[holder-check] all RPC failed, fallback to config/whitelist:', lastErr);
  }
  return null;
}

/* =========================
 * 统一是否持币接口（暴露给前端）
 * ========================= */
export async function resolveIsHolder({ db, address, chainConfig, config }) {
  // 只对 Solana 地址做链上校验
  const isSol = typeof address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) && !address.startsWith('0x');

  // 发币后优先链上
  const hasMintConfigured = isSol && Array.isArray(chainConfig?.mints) && chainConfig.mints.some(m => !!m?.address);
  if (hasMintConfigured) {
    try {
      const r = await checkAnyMintHold({ owner: address, chainConfig });
      if (r && typeof r.ok === 'boolean') return r.ok;
      // 若返回 null 表示所有 RPC 都失败 → 继续 fallback
    } catch (e) {
      console.warn('[holder-check] on-chain failed, fallback to config/whitelist:', e);
    }
  }

  // 未发币 or 链上失败 → 配置/白名单
  if (config?.forceAllAsHolder) return true;
  return await isWhitelisted(db, address);
}

/* =========================
 * 次数计算
 * ========================= */
export function allowedChances(isHolder, config) {
  const h = Number(config?.holderChances ?? 3);
  const n = Number(config?.nonHolderChances ?? 1);
  return isHolder ? h : n;
}

