// holder-check.js
// 统一“是否持币 + 次数配置”
// - 发币前：Firestore 的 config/draw + 可选 whitelist/{address}
// - 发币后：优先链上余额（根据前端传入的 CHAIN.mints）
// 加强点：多 RPC 回退、2.5s 超时、403/-32052 自动切换、记住上次可用 RPC

/* ========== 远程配置：config/draw ========== */
export async function loadRemoteConfig(db, { defaults } = {}) {
  const fallback = defaults || {
    forceAllAsHolder: false,
    holderChances: 3,
    nonHolderChances: 1,
  };
  try {
    const { doc, getDoc } = await import(
      "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore-lite.js"
    );
    const ref = doc(db, "config", "draw");
    const snap = await getDoc(ref);
    if (!snap.exists()) return { ...fallback };
    const d = snap.data() || {};
    return {
      forceAllAsHolder:
        typeof d.forceAllAsHolder === "boolean"
          ? d.forceAllAsHolder
          : fallback.forceAllAsHolder,
      holderChances:
        typeof d.holderChances === "number"
          ? d.holderChances
          : fallback.holderChances,
      nonHolderChances:
        typeof d.nonHolderChances === "number"
          ? d.nonHolderChances
          : fallback.nonHolderChances,
    };
  } catch (e) {
    console.warn("[holder-check] loadRemoteConfig failed, use defaults:", e);
    return { ...fallback };
  }
}

/* ========== 可选白名单：whitelist/{wallet} ========== */
async function isWhitelisted(db, address) {
  try {
    const { doc, getDoc } = await import(
      "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore-lite.js"
    );

    // 先查原值，再查小写（兼容你可能写小写）
    const ref = doc(db, "whitelist", address);
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data()?.holder === true) return true;

    const low = String(address || "").toLowerCase();
    if (low !== address) {
      const ref2 = doc(db, "whitelist", low);
      const snap2 = await getDoc(ref2);
      if (snap2.exists() && snap2.data()?.holder === true) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/* ========== 工具：RPC & 超时 ========== */
function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const k = (x || "").trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

function isApiKeyError(e) {
  const msg = String(e?.message || e || "");
  // 403/forbidden 或 -32052（无/错 key）
  return /-32052|api key|apikey|forbidden|403/i.test(msg);
}

function withTimeout(promise, ms = 2500) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("rpc-timeout")), ms)),
  ]);
}

/** 从 chainConfig 构造 RPC 列表，并把上次成功的 RPC 放前面 */
function buildRpcList(chainConfig) {
  const cluster = (chainConfig?.cluster || "mainnet-beta").trim();
  const primaryA = (chainConfig?.rpc || "").trim();
  const primaryB = (chainConfig?.rpcEndpoint || "").trim();
  const extras = Array.isArray(chainConfig?.extraRpcs)
    ? chainConfig.extraRpcs.map(String)
    : [];

  const LS_KEY = `holdercheck:lastGoodRpc:${cluster}`;
  let lastGood = "";
  try {
    lastGood = localStorage.getItem(LS_KEY) || "";
  } catch {}

  // 公共回退优先 publicnode，官方放最后（前端直连常见限流/CORS）
  const publicFallbacks = [
    "https://solana.publicnode.com",
    "https://solana-rpc.publicnode.com",
    "https://rpc.ankr.com/solana",
    "https://api.mainnet-beta.solana.com",
  ];

  const list = dedupe([lastGood, primaryA || primaryB, ...extras, ...publicFallbacks]);
  return list.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));
}

function rememberGoodRpc(cluster, rpc) {
  try {
    localStorage.setItem(
      `holdercheck:lastGoodRpc:${cluster}`,
      String(rpc || "")
    );
  } catch {}
}

/* ========== 链上余额检查：任一 mint 达阈值即算 holder ========== */
async function checkAnyMintHold({ owner, chainConfig }) {
  const { commitment = "confirmed", mints = [], cluster = "mainnet-beta" } =
    chainConfig || {};
  if (!Array.isArray(mints) || mints.length === 0) return null;

  if (typeof window === "undefined" || !window.solanaWeb3) {
    console.warn("[holder-check] solanaWeb3 not present, skip on-chain");
    return null;
  }

  const { Connection, PublicKey } = window.solanaWeb3;
  const ownerPk = new PublicKey(owner);

  const endpoints = buildRpcList(chainConfig);
  let lastErr = null;

  for (const rpc of endpoints) {
    try {
      const connection = new Connection(rpc, commitment);

      // 逐个 mint 检查余额（每次 2.5s 超时）
      for (const mint of mints) {
        if (!mint?.address) continue;
        const mintPk = new PublicKey(mint.address);

        // 重要：getParsedTokenAccountsByOwner 的 filter 只能二选一，这里只用 mint 过滤
        const resp = await withTimeout(
          connection.getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk }, commitment),
          2500
        );

        let total = 0;
        for (const { account } of resp.value || []) {
          const ui = Number(
            account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0
          );
          total += ui;
        }
        const threshold = Number(mint.minHoldUiAmount ?? 1e-9);
        if (total > threshold) {
          rememberGoodRpc(cluster, rpc);
          return { ok: true, mint: mint.address, amount: total, rpcUsed: rpc };
        }
      }
      // 该 RPC 正常返回但没命中任何 mint → 非持有者（也记住这个可用 RPC）
      rememberGoodRpc(cluster, rpc);
      return { ok: false, rpcUsed: rpc };
    } catch (e) {
      lastErr = e;
      if (isApiKeyError(e)) {
        console.warn(`[holder-check] RPC forbidden/needs key, switch: ${rpc}`, e);
        continue;
      }
      console.warn(`[holder-check] RPC error, switch next: ${rpc}`, e);
      continue;
    }
  }

  if (lastErr) {
    console.warn("[holder-check] all RPC failed, fallback to config/whitelist:", lastErr);
  }
  return null; // 表示链上全失败，交给 fallback
}

/* ========== 统一是否持币接口（暴露给前端） ========== */
export async function resolveIsHolder({ db, address, chainConfig, config }) {
  const addr = String(address || "");
  const isSol =
    !!addr && !addr.startsWith("0x") && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);

  // 发币后优先链上
  const hasMintConfigured =
    isSol &&
    Array.isArray(chainConfig?.mints) &&
    chainConfig.mints.some((m) => !!m?.address);

  if (hasMintConfigured) {
    try {
      const r = await checkAnyMintHold({ owner: addr, chainConfig });
      if (r && typeof r.ok === "boolean") return r.ok; // true/false 都直接返回
      // null 表示所有 RPC 都失败 → 走 fallback
    } catch (e) {
      console.warn("[holder-check] on-chain failed, fallback to config/whitelist:", e);
    }
  }

  // 未发币 or 链上失败 → 配置/白名单
  if (config?.forceAllAsHolder) return true;
  return await isWhitelisted(db, addr);
}

/* ========== 次数计算（暴露给前端） ========== */
export function allowedChances(isHolder, config) {
  const h = Number(config?.holderChances ?? 3);
  const n = Number(config?.nonHolderChances ?? 1);
  return isHolder ? h : n;
}



