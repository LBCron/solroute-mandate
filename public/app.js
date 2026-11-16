const SOL_MINT = "So11111111111111111111111111111111111111112";

const state = {
  mode: "single",
  agentWallet: "",
};

const el = (id) => document.getElementById(id);

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || "—";
  return `${addr.slice(0, 6)}…${addr.slice(-5)}`;
}

function formatUnits(rawStr, decimals, symbol) {
  const val = Number(rawStr) / 10 ** decimals;
  return `${val.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(decimals, 4),
    maximumFractionDigits: Math.min(decimals, 6),
  })} ${symbol}`;
}

function getSelectedTokenMeta() {
  const mint = el("tokenSelect").value;
  if (mint === SOL_MINT) {
    return { mint, decimals: 9, symbol: "SOL" };
  }
  const isUsdg = mint.startsWith("2u1t");
  return { mint, decimals: 6, symbol: isUsdg ? "USDG" : "USDC" };
}

function parsePayrollDestinations(grossRawBigInt) {
  const lines = el("payrollInput")
    .value.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error("Enter at least one destination wallet,ratio line.");
  }

  const parsed = lines.map((line, idx) => {
    const [wallet, ratioStr] = line.split(",").map((s) => s.trim());
    const ratio = Number(ratioStr);
    if (!wallet || !Number.isFinite(ratio) || ratio <= 0) {
      throw new Error(`Line ${idx + 1}: expected format <solanaAddress>,<positiveRatio>`);
    }
    return { wallet, ratio };
  });

  const ratioSum = parsed.reduce((acc, p) => acc + p.ratio, 0);
  let allocated = 0n;
  return parsed.map((p, idx) => {
    const isLast = idx === parsed.length - 1;
    const share = isLast
      ? grossRawBigInt - allocated
      : (grossRawBigInt * BigInt(Math.round((p.ratio / ratioSum) * 1_000_000))) / 1_000_000n;
    allocated += share;
    return { wallet: p.wallet, amountRaw: share.toString() };
  });
}

function showError(msg) {
  const box = el("formErrorBox");
  if (!msg) {
    box.textContent = "";
    box.classList.add("hidden");
    return;
  }
  box.textContent = msg;
  box.classList.remove("hidden");
}

async function apiJson(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `Request failed (${res.status})`;
    throw new Error(data?.error?.code ? `[${data.error.code}] ${msg}` : msg);
  }
  return data;
}

async function refreshQuote() {
  showError("");
  try {
    const meta = getSelectedTokenMeta();
    const amountTokens = Number(el("amountInput").value);
    const tokenPriceUsd = Number(el("priceInput").value);
    const hops = Number(el("hopsInput").value);
    const arrivalSeconds = Number(el("arrivalInput").value);
    const rawBig = BigInt(Math.round(amountTokens * 10 ** meta.decimals));

    const destinationCount =
      state.mode === "payroll"
        ? el("payrollInput")
            .value.split("\n")
            .filter((l) => l.trim()).length
        : undefined;

    const q = await apiJson("/api/pricing/estimate", {
      method: "POST",
      body: JSON.stringify({
        tokenMint: meta.mint,
        amountRaw: rawBig.toString(),
        tokenDecimals: meta.decimals,
        tokenPriceUsd,
        hops,
        arrivalSeconds,
        destinationCount,
      }),
    });

    el("qTier").textContent = `${q.tier} ($${q.usdEquivalent.toFixed(2)})`;
    el("qNetDelivered").textContent = formatUnits(q.hopAmountRaw, meta.decimals, meta.symbol);
    el("qPercentFee").textContent = formatUnits(q.percentFeeRaw, meta.decimals, meta.symbol);
    el("qIntegratorShare").textContent = formatUnits(
      q.integratorPercentShare,
      meta.decimals,
      meta.symbol
    );
    const flatAndScreen =
      (q.totalFlatFeeLamports + q.sol.breakdown.screeningFeeLamports) / 1e9;
    el("qFlatAndScreen").textContent = `${flatAndScreen.toFixed(6)} SOL`;
    el("qRequiredSol").textContent = `${(q.sol.requiredSolUpFrontLamports / 1e9).toFixed(5)} SOL`;
  } catch (err) {
    showError(err.message);
  }
}

function renderProvenance(receipts, webhookEvents = []) {
  const container = el("provenanceContainer");
  el("metricReceiptCount").textContent = String(receipts.length);

  if (receipts.length === 0 && webhookEvents.length === 0) {
    return;
  }

  const itemsHtml = [];

  for (const r of [...receipts].reverse()) {
    const vStatus = r.mandateVerdict.status;
    const badgeClass =
      vStatus === "ALLOW_AUTONOMOUS"
        ? "verdict-allow"
        : vStatus === "REQUIRE_SIGNATURE_APPROVAL"
          ? "verdict-approval"
          : "verdict-deny";

    const sigCount =
      (r.signatures.keeperFundingSignature ? 1 : 0) +
      r.signatures.routeInitSignatures.length +
      (r.signatures.orchestratorInitSignature ? 1 : 0) +
      (r.signatures.sessionInitSignatures?.length || 0) +
      (r.signatures.dispersionInitSignatures?.length || 0);

    itemsHtml.push(`
      <article class="receipt-row">
        <div class="receipt-top">
          <strong class="mono">${r.receiptId} · ${r.commandType}</strong>
          <span class="verdict-badge ${badgeClass}">${vStatus}</span>
        </div>
        <div class="receipt-meta mono">
          <span>Spend: $${r.mandateVerdict.projectedUsdSpend.toFixed(2)}</span>
          <span>Tier: ${r.estimate.tier}</span>
          <span>Broadcast Txs: ${sigCount}</span>
          <span>SHA-256: ${r.provenanceHashSha256.slice(0, 18)}…</span>
        </div>
        <div class="receipt-meta">
          <span>${r.simulationLogs[r.simulationLogs.length - 1] || ""}</span>
        </div>
      </article>
    `);
  }

  for (const w of webhookEvents) {
    itemsHtml.push(`
      <article class="receipt-row">
        <div class="receipt-top">
          <strong class="mono">WEBHOOK · ${w.type}</strong>
          <span class="verdict-badge verdict-allow">HMAC-SHA256 VERIFIED</span>
        </div>
        <div class="receipt-meta mono">
          <span>Event ID: ${w.id}</span>
          <span>Transfer #${w.transferId ?? "—"}</span>
          <span>${w.createdAt}</span>
        </div>
      </article>
    `);
  }

  container.innerHTML = itemsHtml.join("");
}

async function refreshAgentState() {
  const health = await apiJson("/api/health");
  state.agentWallet = health.agentWallet;
  el("runtimeModePill").textContent =
    health.mode === "live_multihopper_api" ? "Live MultiHopper" : "Sandbox Signer";
  el("agentWalletDisplay").textContent = shortAddr(health.agentWallet);
  el("rewardsWalletDisplay").textContent = shortAddr(health.integratorRewardsWallet);

  const mandate = await apiJson("/api/agent/mandate");
  el("metricDailySpend").textContent = `$${mandate.rolling24hSpendUsd.toFixed(2)}`;
  el("metricApprovalCap").textContent = `$${mandate.policy.requireHumanApprovalAboveUsd.toFixed(2)}`;
  el("maxSingleUsdInput").value = mandate.policy.maxSingleTransferUsd;
  el("maxDailyUsdInput").value = mandate.policy.maxDailySpendUsd;
  el("approvalUsdInput").value = mandate.policy.requireHumanApprovalAboveUsd;
  el("haltToggle").checked = mandate.policy.emergencyHalt;

  renderProvenance(mandate.receipts, mandate.webhookEvents);
}

async function derivePdas() {
  const routeId = el("routeIdInput").value || "42";
  const meta = getSelectedTokenMeta();
  const bundle = await apiJson("/api/pdas/derive", {
    method: "POST",
    body: JSON.stringify({
      routeId,
      tokenMint: meta.mint,
      providerId: "lbcron-router",
    }),
  });

  const rows = [
    bundle.routeConfig,
    bundle.routeState,
    bundle.wrapperMint,
    bundle.permanentDelegate,
    bundle.vault,
    bundle.provider,
  ].filter(Boolean);

  el("pdaOutput").innerHTML = rows
    .map(
      (p) => `
      <div class="pda-item">
        <span class="pda-item-label">${p.name} (bump ${p.bump})</span>
        <code class="mono">${shortAddr(p.address)}</code>
      </div>
    `
    )
    .join("");
}

function setMode(mode) {
  state.mode = mode;
  const isSingle = mode === "single";
  el("tabSingle").classList.toggle("is-active", isSingle);
  el("tabSingle").setAttribute("aria-selected", String(isSingle));
  el("tabPayroll").classList.toggle("is-active", !isSingle);
  el("tabPayroll").setAttribute("aria-selected", String(!isSingle));
  el("singleRecipientGroup").classList.toggle("hidden", !isSingle);
  el("payrollGroup").classList.toggle("hidden", isSingle);
  refreshQuote();
}

el("tabSingle").addEventListener("click", () => setMode("single"));
el("tabPayroll").addEventListener("click", () => setMode("payroll"));

el("tokenSelect").addEventListener("change", () => {
  const meta = getSelectedTokenMeta();
  if (meta.symbol === "SOL") {
    el("priceInput").value = "150";
    el("amountInput").value = "0.60";
  } else {
    el("priceInput").value = "1.00";
    el("amountInput").value = "75.00";
  }
  refreshQuote();
  derivePdas();
});

el("quoteBtn").addEventListener("click", refreshQuote);
el("derivePdaBtn").addEventListener("click", derivePdas);

el("verifyMainnetBtn").addEventListener("click", async () => {
  const btn = el("verifyMainnetBtn");
  btn.disabled = true;
  btn.textContent = "Checking Mainnet RPC…";
  try {
    const data = await apiJson("/api/mainnet/programs");
    el("pdaOutput").innerHTML = data.programs
      .map(
        (p) => `
        <div class="pda-item">
          <span class="pda-item-label">${p.label}</span>
          <code class="mono accent-text">${
            p.executable ? "EXECUTABLE" : "MISSING"
          } · ${shortAddr(p.programId)}</code>
        </div>
      `
      )
      .join("");
  } catch (err) {
    showError(`Mainnet RPC check failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Verify Mainnet Programs";
  }
});

el("discoverMcpBtn").addEventListener("click", async () => {
  const btn = el("discoverMcpBtn");
  btn.disabled = true;
  btn.textContent = "Probing MCP…";
  try {
    const data = await apiJson("/api/mcp/discover");
    el("pdaOutput").innerHTML = data.hostedTools
      .slice(0, 6)
      .map(
        (t) => `
        <div class="pda-item">
          <span class="pda-item-label">MCP · ${t.name}</span>
          <code class="mono accent-text">LIVE (${data.hostedCount} tools)</code>
        </div>
      `
      )
      .join("");
  } catch (err) {
    showError(`Live MCP discovery failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Probe Live MCP";
  }
});

el("mandateForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    await apiJson("/api/agent/mandate", {
      method: "POST",
      body: JSON.stringify({
        maxSingleTransferUsd: Number(el("maxSingleUsdInput").value),
        maxDailySpendUsd: Number(el("maxDailyUsdInput").value),
        requireHumanApprovalAboveUsd: Number(el("approvalUsdInput").value),
        emergencyHalt: el("haltToggle").checked,
      }),
    });
    await refreshAgentState();
  } catch (err) {
    showError(err.message);
  }
});

el("routeForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  showError("");
  const btn = el("executeBtn");
  btn.disabled = true;
  btn.textContent = "Signing & Broadcasting…";

  try {
    const meta = getSelectedTokenMeta();
    const amountTokens = Number(el("amountInput").value);
    const tokenPriceUsd = Number(el("priceInput").value);
    const hops = Number(el("hopsInput").value);
    const arrivalSeconds = Number(el("arrivalInput").value);
    const walletSol = Number(el("balanceInput").value);
    const rawBig = BigInt(Math.round(amountTokens * 10 ** meta.decimals));

    const request = {
      tokenMint: meta.mint,
      tokenSymbol: meta.symbol,
      tokenDecimals: meta.decimals,
      amountRaw: rawBig.toString(),
      amountTokens: String(amountTokens),
      tokenPriceUsd,
      hops,
      arrivalSeconds,
      externalId: `ui-${Date.now()}`,
    };

    if (state.mode === "single") {
      request.recipientWallet = el("recipientInput").value.trim();
    } else {
      request.destinations = parsePayrollDestinations(rawBig);
    }

    await apiJson("/api/agent/execute", {
      method: "POST",
      body: JSON.stringify({
        request,
        walletSolBalanceLamports: Math.round(walletSol * 1e9),
        explicitHumanApproval: el("humanApprovalCheck").checked,
      }),
    });

    await refreshAgentState();
    await refreshQuote();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Execute Guarded 5-Stage Route";
  }
});

el("simWebhookBtn").addEventListener("click", async () => {
  try {
    await apiJson("/api/webhooks/simulate", {
      method: "POST",
      body: JSON.stringify({ type: "transfer.completed", transferId: 1001 }),
    });
    await refreshAgentState();
  } catch (err) {
    showError(err.message);
  }
});

(async () => {
  await refreshAgentState();
  await refreshQuote();
  await derivePdas();
})();
