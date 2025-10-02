// holder-check.js
// 作用：统一“是否持币 + 次数配置”
// - 发币前：用 Firestore 的 config/draw（和可选的 whitelist/{address}）决定
// - 发币后：优先走链上余额（根据 index.html 传入的 CHAIN 配置）

// 读取远程配置：config/draw
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

// 可选白名单：whitelist/{walletAddress} { holder:true }
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

// （发币后用）链上余额检查：任一 mint 满足阈值即算 holder
async function checkAnyMintHold({ owner, chainConfig }) {
  const { rpcEndpoint, commitment, mints } = chainConfig || {};
  if (!Array.isArray(mints) || mints.length === 0) return null;

  // 依赖 index.html 里引入的 solanaWeb3 IIFE
  const connection = new solanaWeb3.Connection(
    rpcEndpoint || "https://api.mainnet-beta.solana.com",
    commitment || "confirmed"
  );
  const ownerPk = new solanaWeb3.PublicKey(owner);

  for (const mint of mints) {
    if (!mint?.address) continue;
    const mintPk = new solanaWeb3.PublicKey(mint.address);
    const programId = mint.tokenProgram
      ? new solanaWeb3.PublicKey(mint.tokenProgram)
      : undefined;

    // 指定 programId 兼容 Token-2022；未指定则由 RPC 自判
    const resp = await connection.getParsedTokenAccountsByOwner(
      ownerPk,
      { mint: mintPk, ...(programId ? { programId } : {}) }
    );

    let total = 0;
    for (const { account } of resp.value) {
      const ui = Number(account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
      total += ui;
    }
    const threshold = Number(mint.minHoldUiAmount ?? 1e-9);
    if (total > threshold) return { ok: true, mint: mint.address, amount: total };
  }
  return { ok: false };
}

// 统一的“是否持币”接口
export async function resolveIsHolder({ db, address, chainConfig, config }) {
  // 发币后优先链上
  const hasMintConfigured = Array.isArray(chainConfig?.mints) && chainConfig.mints.some(m => !!m?.address);
  if (hasMintConfigured) {
    try {
      const r = await checkAnyMintHold({ owner: address, chainConfig });
      if (r && typeof r.ok === 'boolean') return r.ok;
      // 若返回 null 表示没配置 mint，继续 fallback
    } catch (e) {
      console.warn('[holder-check] on-chain failed, fallback to config/whitelist:', e);
    }
  }
  // 未发币 or 链上失败 → 配置/白名单
  if (config?.forceAllAsHolder) return true;
  return await isWhitelisted(db, address);
}

// 次数计算
export function allowedChances(isHolder, config) {
  const h = Number(config?.holderChances ?? 3);
  const n = Number(config?.nonHolderChances ?? 1);
  return isHolder ? h : n;
}
