import { join } from "node:path";
import { AuditLog } from "./audit/auditLog.js";
import { Auth } from "./auth/auth.js";
import { ClaudeAnalysisService } from "./ai/claudeAnalysis.js";
import { ConsensusEngine } from "./ai/consensus.js";
import { loadConfig, configWarnings, type AvrrioConfig } from "./config.js";
import { OrderExecutor } from "./execution/orderExecutor.js";
import {
  RecommendationStore,
  type ApprovalMode,
  type Recommendation,
} from "./execution/recommendations.js";
import { MarketDataReader, type MarketSnapshot } from "./market/marketData.js";
import {
  buildTradeContext,
  computeWhatIf,
  type WhatIfResult,
} from "./ai/tradeChat.js";
import { buildDebate, type DebateResult } from "./ai/debate.js";
import { coachReview, type CoachReview } from "./ai/tradeCoach.js";
import {
  computeTradeGrade,
  tradeGradeText,
  type TradeGradeResult,
} from "./ai/tradeGrade.js";
import { selectOrderType } from "./ai/orderSelection.js";
import {
  rankMarket,
  rankMarketsText,
  type MarketRank,
} from "./ai/rankMarkets.js";
import { assessPosition, managementText } from "./ai/tradeManagement.js";
import {
  explainSymbol,
  explainSymbolText,
  type SymbolExplanation,
} from "./ai/explainWhy.js";
import { TradeMemory, type MemoryAssessment } from "./memory/tradeMemory.js";
import { NewsReader } from "./news/newsReader.js";
import { NotificationManager } from "./notifications/notifier.js";
import { EmailNotifier } from "./notifications/emailNotifier.js";
import { TelegramService } from "./telegram/telegramService.js";
import { RiskManager, type RiskContext } from "./risk/riskManager.js";
import { pointValue } from "./risk/rules.js";
import { RuntimeSettings } from "./settings/runtimeSettings.js";
import { Scheduler, type NearMiss } from "./scheduler/scheduler.js";
import {
  Scanner,
  scoreSnapshot,
  suggestLevels,
  type ScanOptions,
  type ScanResult,
} from "./scanner/scanner.js";
import { KillSwitch } from "./safety/killSwitch.js";
import { findSetup, withinAllowedHours } from "./setups/index.js";
import { findSymbol, isTradable, SYMBOLS } from "./symbols/registry.js";
import {
  extractMentionedSymbols,
  mentionsOpenPositions,
} from "./ai/conversationContext.js";
import { TradeJournal } from "./journal/tradeJournal.js";
import { TopstepClient } from "./topstep/client.js";
import { sendSms, samePhone, smsMissing } from "./sms/smsClient.js";
import { parseSmsCommand, type SmsCommand } from "./sms/inbound.js";
import { formatOpportunitySms, formatSignalSms } from "./sms/messages.js";
import type {
  AccountSummary,
  AuthTestResult,
  OrderResult,
  Side,
  TopstepStatus,
  TradeIdea,
  TradingMode,
} from "./types.js";

export interface LiveTradingChecklist {
  projectxAuth: boolean;
  tokenReceived: boolean;
  accountFound: boolean;
  telegramTestPassed: boolean;
  emergencyStopTested: boolean;
  maxDailyLossConfigured: boolean;
  maxPositionSizeConfigured: boolean;
  paperApprovalTestPassed: boolean;
  ready: boolean;
  blockers: string[];
}

/** Consolidated, operator-facing live-trading readiness report. */
export interface ReadinessReport {
  projectxAuth: boolean;
  accountSync: {
    connected: boolean;
    accountId: string;
    buyingPower: number;
    dailyPnL: number;
    lastSyncTime: string | null;
  };
  telegram: boolean;
  emergencyStop: boolean;
  riskLimits: { dailyLoss: boolean; positionSize: boolean };
  paperApproval: boolean;
  blockers: string[];
  /** Checklist items passed / total, plus a 0-100 percentage. */
  passed: number;
  total: number;
  scorePct: number;
  /** Always false during the safety-validation phase. */
  liveTradingEnabled: boolean;
  /** True only when every check passes (live trading may then be enabled). */
  ready: boolean;
}

export interface ProposeInput extends TradeIdea {
  /** Optional predefined setup this idea belongs to. */
  setupName?: string;
  /** Operator override to bypass a news block (manual only). */
  newsOverride?: boolean;
}

/**
 * Composition root tying together the read-only client, market reader, AI
 * consensus, risk manager, journal, recommendation store, order executor, kill
 * switch, news reader, auth, and audit log.
 */
export class AvrrioEngine {
  readonly config: AvrrioConfig;
  readonly client: TopstepClient;
  readonly market: MarketDataReader;
  readonly risk: RiskManager;
  readonly journal: TradeJournal;
  readonly claude: ClaudeAnalysisService;
  readonly consensus: ConsensusEngine;
  readonly news: NewsReader;
  readonly scanner: Scanner;
  readonly audit: AuditLog;
  readonly killSwitch: KillSwitch;
  readonly recommendations: RecommendationStore;
  readonly executor: OrderExecutor;
  readonly notifications: NotificationManager;
  readonly telegram: TelegramService;
  readonly settings: RuntimeSettings;
  readonly scheduler: Scheduler;
  readonly auth: Auth;
  readonly memory: TradeMemory;
  // Validation flags (Telegram/Emergency Stop/paper approval) are persisted in
  // RuntimeSettings so they survive restarts; auth/token/account below stay
  // live-checked so a broken connection always reflects reality.
  private lastAuthTest: AuthTestResult | null = null;

  constructor(config = loadConfig()) {
    this.config = config;
    // All file-backed state lives under config.dataDir so it can be redirected
    // to a mounted persistent disk (Render etc.) and survive redeploys.
    const dataPath = (file: string) => join(config.dataDir, file);
    this.audit = new AuditLog(dataPath("audit.jsonl"));
    this.settings = new RuntimeSettings(config, dataPath("settings.json"));
    this.client = new TopstepClient(config);
    this.market = new MarketDataReader(this.client);
    this.risk = new RiskManager();
    this.journal = new TradeJournal(dataPath("journal.json"));
    this.claude = new ClaudeAnalysisService(config);
    this.consensus = new ConsensusEngine(config);
    this.news = new NewsReader(config);
    this.scanner = new Scanner(this.market, this.news);
    this.killSwitch = new KillSwitch(
      config,
      this.audit,
      dataPath("kill-switch.json"),
    );
    this.recommendations = new RecommendationStore(
      dataPath("recommendations.json"),
    );
    this.executor = new OrderExecutor(
      this.settings,
      this.client,
      this.killSwitch,
      this.recommendations,
      this.audit,
    );
    // SMS and Telegram have dedicated, fully-formatted alert paths, so only email
    // is registered here (avoids duplicate notifications).
    this.notifications = new NotificationManager(config, [
      new EmailNotifier(config),
    ]);
    this.telegram = new TelegramService(config);
    this.auth = new Auth(config);
    this.scheduler = new Scheduler(this, config, this.settings);
    this.memory = new TradeMemory(dataPath("memory.json"));
  }

  async init(): Promise<void> {
    await Promise.all([
      this.journal.load(),
      this.killSwitch.load(),
      this.recommendations.load(),
      this.settings.load(),
      this.memory.load(),
    ]);
  }

  warnings(): string[] {
    // Reflect runtime-toggled state (persisted), not just env defaults, so the
    // full-auto / live-trading safety warnings stay accurate after a switch.
    return configWarnings(this.config, {
      liveTradingEnabled: this.settings.isLiveTradingEnabled(),
      tradingMode: this.settings.getTradingMode(),
    });
  }

  /** AI assistant health (Claude status/model/last success/last error + providers). */
  aiHealth(): {
    status: "online" | "offline";
    enabled: boolean;
    model: string;
    lastSuccessAt: string | null;
    lastError: string | null;
    providers: string[];
  } {
    return {
      ...this.claude.health(),
      providers: this.consensus.availableProviders(),
    };
  }

  /**
   * Full pipeline diagnostics — answers "is the scan→alert→assistant pipeline
   * connected end to end?" Read-only, no secrets.
   */
  pipelineDiagnostics() {
    const sched = this.scheduler.stats();
    const ai = this.aiHealth();
    const s = this.client.status();
    return {
      scheduler: {
        running: sched.enabled,
        intervalMinutes: sched.intervalMinutes,
        scansToday: sched.scansToday,
        lastScanTime: sched.lastScanTime,
        lastAlertTime: sched.lastAlertTime,
      },
      telegram: {
        configured: this.telegram.enabled,
        missing: this.telegram.missing(),
        presence: this.telegram.presence(),
      },
      ai: {
        status: ai.status,
        model: ai.model,
        lastSuccessAt: ai.lastSuccessAt,
        lastError: ai.lastError,
        providers: ai.providers,
      },
      trading: {
        mode: this.getTradingMode(),
        liveTrading: this.isLiveTradingEnabled(),
        paper: !this.isLiveTradingEnabled(),
      },
      safety: { emergencyStop: this.killSwitch.isEngaged() },
      topstepx: {
        connected: s.connected,
        authenticated: s.authenticated,
        accountId: s.accountId,
        accountStatus: s.accountStatus,
      },
      lastScan: this.scheduler.lastScan(),
      process:
        "Single web process — the scheduler runs in-process via setInterval; no separate worker is required.",
    };
  }

  /** Telegram-friendly diagnostics text for /diag. */
  pipelineDiagnosticsText(): string {
    const d = this.pipelineDiagnostics();
    const yn = (b: boolean) => (b ? "✅" : "❌");
    const lines = [
      "🩺 AVRRIO PIPELINE DIAGNOSTICS",
      `${yn(d.scheduler.running)} Scheduler running — every ${d.scheduler.intervalMinutes}m · scans today ${d.scheduler.scansToday}`,
      `   last scan ${d.scheduler.lastScanTime ? new Date(d.scheduler.lastScanTime).toLocaleTimeString() : "—"} · last alert ${d.scheduler.lastAlertTime ? new Date(d.scheduler.lastAlertTime).toLocaleTimeString() : "—"}`,
      `${yn(d.telegram.configured)} Telegram configured${d.telegram.missing.length ? " — missing: " + d.telegram.missing.join(", ") : ""}`,
      `${yn(d.ai.status === "online")} Claude/AI ${d.ai.status} (${d.ai.model})${d.ai.lastError ? " — " + String(d.ai.lastError).slice(0, 60) : ""} · providers: ${d.ai.providers.join("+") || "none"}`,
      `${yn(d.topstepx.connected)} TopstepX ${d.topstepx.connected ? "connected" : "not connected"} · acct ${d.topstepx.accountId}`,
      `Mode: ${d.trading.mode} · ${d.trading.liveTrading ? "LIVE" : "paper"} · Emergency Stop: ${d.safety.emergencyStop ? "ENGAGED 🛑" : "clear"}`,
      d.process,
    ];
    if (d.lastScan) {
      lines.push(
        "",
        `Last scan: ${d.lastScan.scanned} scanned, ${d.lastScan.qualifying} qualifying, ${d.lastScan.alerted} alerted.`,
      );
      if (d.lastScan.reasons.length)
        lines.push("No-trade reasons: " + d.lastScan.reasons.join("; "));
    }
    return lines.join("\n");
  }

  getAccount(): Promise<AccountSummary> {
    return this.client.getAccount();
  }

  snapshot(symbol: string): Promise<MarketSnapshot> {
    return this.market.snapshot(symbol);
  }

  /** Scan and rank the symbol universe by Avrrio Score. */
  scan(options?: ScanOptions): Promise<ScanResult[]> {
    return this.scanner.scan(options);
  }

  /**
   * Generate a recommendation: AI consensus + news + full risk stack. Stores it
   * as pending (or blocked). In semi-autonomous mode, auto-executes only when
   * every gate passes.
   */
  async propose(input: ProposeInput): Promise<Recommendation> {
    const account = await this.getAccount();
    const snapshot = await this.snapshot(input.symbol);
    const setup = input.setupName ? findSetup(input.setupName) : undefined;

    const [consensus, news] = await Promise.all([
      this.consensus.evaluate(snapshot, account),
      this.news.assess(input.symbol),
    ]);

    const context: RiskContext = {
      symbolTradable: isTradable(input.symbol),
      killSwitchEngaged: this.killSwitch.isEngaged(),
      news,
      newsOverride: input.newsOverride ?? false,
      tradesToday: this.recommendations.executedToday(),
      duplicateOpen: this.recommendations.hasOpenDuplicate(
        input.symbol,
        input.side,
      ),
      withinAllowedHours: setup ? withinAllowedHours(setup) : undefined,
      safety: {
        maxPositionSize: this.config.safety.maxPositionSize,
        maxTradesPerDay: this.config.safety.maxTradesPerDay,
        maxRiskPerTrade: this.config.safety.maxRiskPerTrade,
        maxDailyLoss: this.config.safety.dailyMaxLoss,
      },
    };

    const assessment = this.risk.assess(input, account, context);
    const { score: avrrioScore, components } = scoreSnapshot(
      snapshot,
      news.blocked,
    );
    const grade = computeTradeGrade(
      {
        components,
        rewardRiskRatio: assessment.rewardRiskRatio,
        riskApproved: assessment.approved,
        consensus: {
          agreement: consensus.agreement,
          available: consensus.available,
        },
      },
      this.config.ai.qualityThreshold,
    );
    const orderSelection = selectOrderType(
      { side: input.side, entry: input.entry },
      snapshot.quote.last,
    );

    const consensusAgrees =
      consensus.recommendation === input.side &&
      consensus.agreement >= 2 &&
      consensus.confidence >= this.config.ai.confidenceThreshold;

    const autoEligible =
      this.settings.getTradingMode() === "full_auto" &&
      assessment.approved &&
      !this.killSwitch.isEngaged() &&
      !news.blocked &&
      consensusAgrees;

    const rec = await this.recommendations.add({
      setupName: input.setupName ?? null,
      symbol: input.symbol,
      side: input.side,
      size: input.size,
      entry: input.entry,
      stopLoss: input.stopLoss,
      target: input.target,
      riskAmount: assessment.riskAmount,
      rewardRiskRatio: assessment.rewardRiskRatio,
      riskApproved: assessment.approved,
      violations: assessment.violations,
      avrrioScore,
      grade,
      orderType: orderSelection.orderType,
      orderTypeRationale: orderSelection.rationale,
      consensus: {
        recommendation: consensus.recommendation,
        confidence: consensus.confidence,
        agreement: consensus.agreement,
        available: consensus.available,
        opinions: consensus.opinions,
      },
      news,
      autoEligible,
      expiresAt: new Date(
        Date.now() + this.config.queue.approvalExpiryMinutes * 60_000,
      ).toISOString(),
      approvalMode: null,
    });

    await this.audit.log("recommendation.created", "system", {
      recommendationId: rec.id,
      symbol: rec.symbol,
      side: rec.side,
      riskApproved: rec.riskApproved,
      autoEligible,
      consensus: consensus.recommendation,
      agreement: consensus.agreement,
    });

    // Mirror into the journal for the historical record.
    await this.journal.record(input, assessment.approved);

    if (autoEligible) {
      // Semi-autonomous: every gate passed, execute now.
      const result = await this.executor.execute(rec, "system");
      if (result.accepted) void this.autoCoach(rec); // post-trade review
    } else if (rec.status === "pending" && grade.qualifies) {
      // Manual/pre-approved: alert the operator so they can approve from a
      // phone — but only for setups that clear the Trade Quality Score gate.
      // Avrrio isn't looking for more trades, it's looking for better trades.
      await this.dispatchAlert(rec);
    } else if (rec.status === "pending") {
      await this.audit.log("telegram.alert_suppressed_low_quality", "system", {
        ref: rec.ref,
        qualityScore: grade.qualityScore,
        threshold: this.config.ai.qualityThreshold,
      });
    }

    return rec;
  }

  /**
   * Visible pipeline stage log (shows in the host/Render logs) using the exact
   * stage tokens, so the end-to-end scan→alert→assistant pipeline is traceable.
   */
  stage(name: string, details: Record<string, unknown> = {}): void {
    try {
      console.log(`[avrrio] ${name} ${JSON.stringify(details)}`);
    } catch {
      console.log(`[avrrio] ${name}`);
    }
  }

  /**
   * Sends a trade alert to Telegram only. Telegram carries the full trade detail
   * plus one-tap APPROVE / REJECT / STOP ALL buttons. SMS remains disabled unless
   * an operator explicitly re-enables SMS endpoints for legacy use.
   */
  private async dispatchAlert(rec: Recommendation): Promise<void> {
    if (!this.telegram.enabled) {
      this.stage("TELEGRAM_SEND_FAILED", {
        ref: rec.ref,
        reason: "telegram not configured",
      });
      await this.audit.log("telegram.alert_skipped", "system", {
        ref: rec.ref,
        info: "Telegram not configured; SMS fallback disabled.",
      });
      return;
    }
    this.stage("TELEGRAM_SEND_STARTED", { ref: rec.ref, symbol: rec.symbol });
    const r = await this.telegram.sendAlert(rec);
    this.stage(r.ok ? "TELEGRAM_SEND_SUCCESS" : "TELEGRAM_SEND_FAILED", {
      ref: rec.ref,
      info: r.info,
    });
    await this.audit.log("telegram.alert_sent", "system", {
      ref: rec.ref,
      ok: r.ok,
      info: r.info,
    });
    // Avrrio Memory: if this setup resembles one the operator has struggled
    // with, follow the alert with a heads-up (advisory — it does not block).
    const mem = this.assessMemory(rec.ref);
    if (mem.matched && (mem.level === "warn" || mem.level === "caution")) {
      await this.telegram.sendText(`🧠 Heads-up on ${rec.ref}: ${mem.message}`);
      await this.audit.log("memory.alert_warning", "system", {
        ref: rec.ref,
        level: mem.level,
        winRate: mem.winRate,
      });
    }
  }

  /**
   * Sends a low-key "watch" alert for a setup that's close but not ready. This
   * is informational only — it never proposes or executes a trade, and real
   * trade alerts are still reserved for fully-qualified setups.
   */
  async sendWatchAlert(nm: NearMiss): Promise<void> {
    this.stage("WATCH_ALERT", {
      symbol: nm.symbol,
      side: nm.side,
      score: nm.score,
    });
    if (!this.telegram.enabled) return;
    const text = [
      `👀 WATCH — ${nm.symbol} ${(nm.side ?? "").toUpperCase()}`,
      `Avrrio score ${nm.score}${nm.rr != null ? ` · R:R ${nm.rr}` : ""} — close but not A+ yet.`,
      `Not ready: ${nm.reasons.join("; ") || "—"}`,
      "No action needed. You'll get a full alert only if it qualifies.",
    ].join("\n");
    const r = await this.telegram.sendText(text);
    await this.audit.log("telegram.watch_alert", "system", {
      symbol: nm.symbol,
      side: nm.side,
      score: nm.score,
      ok: r.ok,
    });
  }

  /**
   * Applies an approval action (from a Telegram button or elsewhere) through the
   * same safety gates as SMS approval. Returns the operator confirmation text.
   */
  async approvalAction(
    action: "approve" | "reject" | "stopall" | "details",
    ref: string,
  ): Promise<string> {
    if (action === "approve") {
      if (this.settings.getTradingMode() === "advisor") {
        await this.audit.log("approve.advisor_only", "operator", { ref });
        return `ℹ️ Advisor mode: Avrrio does not place orders. Enter ${ref} manually in TopstepX if you want it.`;
      }
      return this.approveBySms(ref);
    }
    if (action === "reject") return this.rejectBySms(ref);
    if (action === "details") return this.telegramDetails(ref);
    await this.engageKill("emergency stop (button)", "operator");
    return "🛑 Emergency Stop activated. No trades can execute.";
  }

  // --- Telegram (primary alert channel) ---------------------------------
  async telegramTest() {
    const r = await this.telegram.sendTest();
    if (r.ok) await this.settings.markValidation("telegramTestPassed");
    await this.audit.log("telegram.test_sent", "operator", {
      ok: r.ok,
      info: r.info,
    });
    return r;
  }
  telegramDebug() {
    return this.telegram.debug();
  }
  telegramSetWebhook(url: string) {
    return this.telegram.setWebhook(url);
  }
  /** Process an inbound Telegram webhook: button presses AND text commands. */
  async handleTelegramWebhook(body: unknown): Promise<void> {
    const cb = this.telegram.parseCallback(body);
    if (cb) {
      await this.telegram.handleCallback(cb, (action, ref) =>
        this.approvalAction(action, ref),
      );
      return;
    }
    const msg = this.telegram.parseMessage(body);
    if (msg) await this.handleTelegramCommand(msg.chatId, msg.text);
  }

  /**
   * Routes a Telegram text command. Authorized by chat id. Advisory by default —
   * only /approve, /reject, /stop, /resume change state, and each runs through
   * the existing safety gates. Never executes a trade from free-form chat.
   */
  async handleTelegramCommand(chatId: string, text: string): Promise<string> {
    if (!this.telegram.isAuthorized(chatId)) {
      await this.audit.log("telegram.command_unauthorized", chatId, {
        text: text.slice(0, 40),
      });
      return "unauthorized";
    }
    const trimmed = text.trim();
    const isCommand = trimmed.startsWith("/");
    const parts = trimmed.split(/\s+/);
    // Plain (non-slash) text is treated as a conversational question to Claude.
    const cmd = isCommand ? (parts[0] ?? "").toLowerCase() : "/ask";
    const arg = isCommand ? parts.slice(1).join(" ").trim() : trimmed;
    await this.audit.log("telegram.command", "telegram", {
      command: cmd,
      hasArg: arg.length > 0,
    });

    let reply: string;
    switch (cmd) {
      case "/scan":
      case "/scan_now":
      case "/scannow":
        reply = await this.cmdScanNow();
        break;
      case "/rank":
      case "/ranks":
      case "/rank_markets":
        reply = await this.rankMarketsText();
        break;
      case "/why":
      case "/why_no_trade":
        if (arg) {
          reply = await this.explainSymbolText(arg);
        } else {
          await this.scheduler.runScanCycle(); // fresh scan, then explain
          reply = await this.scanExplanation();
        }
        break;
      case "/status":
        reply = await this.cmdStatus();
        break;
      case "/diag":
      case "/diagnostics":
        reply = this.pipelineDiagnosticsText();
        break;
      case "/last_signal":
      case "/lastsignal":
        reply = this.cmdLastSignal();
        break;
      case "/risk":
        reply = await this.cmdRisk();
        break;
      case "/settings":
        reply = this.cmdSettings();
        break;
      case "/pause":
        reply = await this.cmdPauseScanner();
        break;
      case "/ask":
        reply = arg
          ? await this.claude.ask(arg, await this.buildConversationContext(arg))
          : "Usage: /ask <your question> — or just type your question.";
        break;
      case "/discuss":
      case "/ask_trade":
        reply = await this.cmdDiscuss(arg);
        break;
      case "/whatif":
      case "/what_if":
        reply = await this.cmdWhatIf(arg);
        break;
      case "/debate":
        reply = await this.cmdDebate(arg);
        break;
      case "/coach":
      case "/review":
        reply = await this.cmdCoach(arg);
        break;
      case "/memory":
      case "/history":
        reply = this.cmdMemory(arg);
        break;
      case "/approve":
        reply = arg
          ? await this.approvalAction("approve", arg)
          : "Usage: /approve <trade id>";
        break;
      case "/reject":
        reply = arg
          ? await this.approvalAction("reject", arg)
          : "Usage: /reject <trade id>";
        break;
      case "/stop":
        await this.engageKill("Telegram /stop", "telegram");
        reply =
          "🛑 Emergency Stop ENGAGED. All trading is blocked. Reply /resume confirm to clear.";
        break;
      case "/resume":
        reply = await this.cmdResume(arg);
        break;
      case "/help":
      case "/start":
        reply = TELEGRAM_HELP;
        break;
      default:
        reply = `Unknown command "${cmd}".\n\n${TELEGRAM_HELP}`;
    }
    await this.telegram.sendText(reply);
    return reply;
  }

  /** /last_signal — the most recent recommendation + last scan summary. */
  private cmdLastSignal(): string {
    const recs = this.recommendations.list();
    const last = recs[recs.length - 1];
    const scan = this.scheduler.lastScan();
    const lines = ["📡 LAST SIGNAL"];
    if (last) {
      const rr =
        Math.abs(last.entry - last.stopLoss) > 0
          ? (
              Math.abs(last.target - last.entry) /
              Math.abs(last.entry - last.stopLoss)
            ).toFixed(1)
          : "n/a";
      lines.push(
        `${last.ref}: ${last.symbol} ${last.side.toUpperCase()} ×${last.size} — ${last.status}`,
        `Entry ${last.entry} · Stop ${last.stopLoss} · Target ${last.target} · R:R ${rr}`,
        `Avrrio score ${last.avrrioScore ?? "n/a"} · created ${new Date(last.createdAt).toLocaleString()}`,
      );
    } else {
      lines.push("No recommendations yet.");
    }
    if (scan) {
      lines.push(
        "",
        `Last scan: ${scan.scanned} scanned, ${scan.qualifying} qualifying, ${scan.alerted} alerted.`,
      );
      if (scan.reasons.length)
        lines.push("No-trade reasons: " + scan.reasons.join("; "));
    }
    return lines.join("\n");
  }

  /**
   * /discuss <ref> <question> — per-trade conversation. If no ref is given, uses
   * the most recent recommendation so the operator can just ask a follow-up.
   */
  private async cmdDiscuss(arg: string): Promise<string> {
    if (!arg) {
      return 'Usage: /discuss <T-ref> <question> — e.g. "/discuss T-1042 why not buy now?" (omit the ref to ask about the latest signal).';
    }
    const { ref, question } = this.splitRefAndText(arg);
    if (!question)
      return "Add a question, e.g. /discuss T-1042 where should I enter?";
    const r = await this.discussTrade(ref, question);
    return `💬 ${r.ref} — ${question}\n\n${r.answer}`;
  }

  /**
   * /whatif <ref> <scenario> — live R:R recompute. If no ref is given, uses the
   * most recent recommendation.
   */
  private async cmdWhatIf(arg: string): Promise<string> {
    if (!arg) {
      return 'Usage: /whatif <T-ref> <scenario> — e.g. "/whatif T-1042 move my stop to 20010" or "/whatif T-1042 only one contract".';
    }
    const { ref, question: scenario } = this.splitRefAndText(arg);
    if (!scenario)
      return "Add a scenario, e.g. /whatif T-1042 move my stop to 20010.";
    try {
      const r = await this.whatIf(ref, scenario);
      return r.interpretation
        ? `${r.summary}\n\n🧠 ${r.interpretation}`
        : r.summary;
    } catch (err) {
      return err instanceof Error ? err.message : "Could not run that what-if.";
    }
  }

  /**
   * /debate <T-ref|symbol> — Bull/Bear/Verdict. Defaults to the latest signal
   * when nothing is given.
   */
  private async cmdDebate(arg: string): Promise<string> {
    let target = arg.trim();
    if (!target) {
      const recs = this.recommendations.list();
      const latest = recs[recs.length - 1];
      if (!latest)
        return "Usage: /debate <T-ref or symbol> — e.g. /debate T-1042 or /debate NQ.";
      target = latest.ref;
    }
    const r = await this.debate(target);
    return r.interpretation
      ? `${r.summary}\n\n🧠 ${r.interpretation}`
      : r.summary;
  }

  /**
   * /memory — overall habit stats, or /memory <T-ref> to check one trade against
   * history ("does this resemble a pattern you've struggled with?").
   */
  private cmdMemory(arg: string): string {
    const ref = arg.trim();
    if (!ref) return this.memorySummaryText();
    const a = this.assessMemory(ref);
    return `🧠 MEMORY CHECK${a.ref ? ` — ${a.ref}` : ""}\n${a.message}`;
  }

  /**
   * /coach <T-ref> — post-trade review. Defaults to the latest signal when
   * nothing is given.
   */
  private async cmdCoach(arg: string): Promise<string> {
    let ref = arg.trim();
    if (!ref) {
      const recs = this.recommendations.list();
      const latest = recs[recs.length - 1];
      if (!latest)
        return "Usage: /coach <T-ref> — reviews a trade against your discipline rules.";
      ref = latest.ref;
    }
    try {
      const r = await this.coachTrade(ref);
      return r.interpretation
        ? `${r.summary}\n\n🧠 ${r.interpretation}`
        : r.summary;
    } catch (err) {
      return err instanceof Error
        ? err.message
        : "Could not review that trade.";
    }
  }

  /**
   * Splits "<T-ref> <rest>" — if the first token looks like a trade ref (T-1234)
   * it's used as the ref; otherwise the whole string is the question and the ref
   * defaults to the latest recommendation.
   */
  private splitRefAndText(arg: string): { ref: string; question: string } {
    const parts = arg.trim().split(/\s+/);
    const first = parts[0] ?? "";
    if (/^t-?\d+$/i.test(first)) {
      return {
        ref: first.toUpperCase().replace(/^T(?=\d)/, "T-"),
        question: parts.slice(1).join(" ").trim(),
      };
    }
    const recs = this.recommendations.list();
    const latest = recs[recs.length - 1];
    return { ref: latest?.ref ?? "", question: arg.trim() };
  }

  /** /risk — current risk limits and usage. */
  private async cmdRisk(): Promise<string> {
    const lines = [
      "🛡️ RISK LIMITS",
      `Max position size: ${this.config.safety.maxPositionSize || "—"} contracts`,
      `Max risk/trade: $${this.config.safety.maxRiskPerTrade || 0}`,
      `Max trades/day: ${this.config.safety.maxTradesPerDay} · taken today: ${this.recommendations.executedToday()}`,
      `Internal daily-loss cap: $${this.config.safety.dailyMaxLoss || 0} (stricter of this and the broker limit applies)`,
    ];
    try {
      const a = await this.getAccount();
      const remaining = a.rules.maxDailyLoss - Math.max(0, -a.dayPnl);
      lines.push(
        `Broker daily loss: $${a.rules.maxDailyLoss} · day P&L ${a.dayPnl >= 0 ? "+" : ""}$${a.dayPnl} · $${remaining.toFixed(0)} remaining`,
      );
    } catch {
      /* account optional */
    }
    lines.push(
      `Emergency Stop: ${this.killSwitch.isEngaged() ? "ENGAGED 🛑" : "clear"}`,
    );
    return lines.join("\n");
  }

  /** /settings — current operational settings. */
  private cmdSettings(): string {
    const sched = this.scheduler.stats();
    return [
      "⚙️ SETTINGS",
      `Trading mode: ${this.getTradingMode()} · ${this.isLiveTradingEnabled() ? "LIVE" : "paper"}`,
      `Scanner: ${sched.enabled ? "ON" : "off"} every ${sched.intervalMinutes}m`,
      `Alert thresholds: Avrrio score ≥ ${this.config.notifications.opportunityAlertScore}, R:R ≥ ${this.config.scheduler.minRewardRisk}, Trade Quality Score ≥ ${this.config.ai.qualityThreshold}, max ${this.config.scheduler.maxAlerts}/cycle`,
      `Report hours: ${this.config.scheduler.reportHours.join(", ") || "none"} · timezone: ${this.config.accountTimezone || "server local"}`,
      `AI: ${this.aiHealth().status} (${this.aiHealth().model})`,
      `Data dir: ${this.config.dataDir}${this.config.dataDir === "data" ? " (default — set DATA_DIR to a mounted disk to persist across redeploys)" : ""}`,
    ].join("\n");
  }

  /** /pause — pause the scheduled scanner (no new scans/alerts until /resume). */
  private async cmdPauseScanner(): Promise<string> {
    await this.setScheduler(false, undefined, "telegram");
    return "⏸️ Scanner paused. No new scans or alerts until /resume. (Trading approvals and safety controls are unaffected.)";
  }

  private async cmdScanNow(): Promise<string> {
    const r = await this.scheduler.runScanCycle();
    if (r.alerted > 0) {
      return `🔍 Scan complete — ${r.alerted} alert(s) sent: ${r.refs.join(", ")}. Approve from the alert buttons or /approve <id>.`;
    }
    return `🔍 Scan complete — no qualifying setup.\n\n${await this.scanExplanation()}`;
  }

  private async cmdStatus(): Promise<string> {
    const s = this.client.status();
    const sched = this.scheduler.stats();
    const ai = this.aiHealth();
    return [
      "📊 AVRRIO STATUS",
      `Mode: ${this.getTradingMode()} · Trading: ${this.isLiveTradingEnabled() ? "LIVE" : "paper"}`,
      `TopstepX: ${s.connected ? "connected" : "not connected"} (${s.accountStatus}) · Acct ${s.accountId}`,
      `Buying power: $${(s.availableBuyingPower || 0).toLocaleString()} · Day P&L: ${s.dailyPnL >= 0 ? "+" : ""}$${(s.dailyPnL || 0).toLocaleString()}`,
      `Open positions: ${s.openPositions}`,
      `Kill switch: ${this.killSwitch.isEngaged() ? "ENGAGED 🛑" : "clear"}`,
      `Scheduler: ${sched.enabled ? "ON" : "off"} (every ${sched.intervalMinutes}m) · scans today ${sched.scansToday}`,
      `AI: ${ai.status} (${ai.model})${ai.status === "offline" ? " — set ANTHROPIC_API_KEY" : ""} · providers: ${ai.providers.join("+") || "none"}`,
      `Pending approvals: ${this.recommendations.pending().length}`,
    ].join("\n");
  }

  private async cmdResume(arg: string): Promise<string> {
    // Always resume the scanner.
    await this.setScheduler(true, undefined, "telegram");
    const lines = ["▶️ Scanner resumed."];
    // If the Emergency Stop is engaged, only clear it on explicit confirm.
    if (this.killSwitch.isEngaged()) {
      if (arg.toLowerCase() === "confirm") {
        const ok = await this.disengageKill("telegram");
        lines.push(
          ok
            ? "✅ Emergency Stop cleared. Every trade still requires your approval."
            : "⚠️ Could not clear the Emergency Stop (it may be forced by the KILL_SWITCH env var).",
        );
      } else {
        lines.push(
          "⚠️ Emergency Stop is still ENGAGED — reply '/resume confirm' to clear it.",
        );
      }
    }
    return lines.join("\n");
  }

  /** Secret-free context string passed to Claude for /ask. */
  private async askContext(): Promise<string> {
    const s = this.client.status();
    return [
      "Context for the Avrrio Trade AI assistant (advisory only):",
      `Trading mode: ${this.getTradingMode()} · ${this.isLiveTradingEnabled() ? "LIVE" : "paper"}.`,
      `TopstepX: ${s.connected ? "connected" : "not connected"}, account ${s.accountId}, day P&L $${s.dailyPnL}, buying power $${s.availableBuyingPower}.`,
      `Emergency Stop: ${this.killSwitch.isEngaged() ? "engaged" : "clear"}. Pending approvals: ${this.recommendations.pending().length}.`,
    ].join("\n");
  }

  /**
   * Enriches the base /ask context with whatever the operator's free-form
   * message is actually about: any known symbols mentioned by name (live
   * snapshot/score/news) and, if they asked about "my position(s)", a summary
   * of every open position. Lets Telegram conversation work naturally
   * ("what about NQ right now?", "how's my position doing?") without
   * requiring a rigid "/discuss T-1042" reference. Read-only — never trades.
   */
  async buildConversationContext(text: string): Promise<string> {
    const lines = [await this.askContext()];

    const symbols = extractMentionedSymbols(
      text,
      SYMBOLS.map((s) => s.symbol),
    ).slice(0, 3);
    for (const symbol of symbols) {
      try {
        const snapshot = await this.snapshot(symbol);
        const news = await this.news.assess(symbol);
        const { score } = scoreSnapshot(snapshot, news.blocked);
        lines.push(
          "",
          `Symbol mentioned: ${symbol} (${findSymbol(symbol)?.name ?? symbol}, ${isTradable(symbol) ? "tradable futures" : "watchlist-only"})`,
          `Last: ${snapshot.quote.last} · Avrrio Score: ${score}/100 · Trend: ${snapshot.structure.trend} · News: ${news.blocked ? news.reason || "blackout" : "clear"}`,
        );
        const open = this.recommendations
          .openPositions()
          .filter((r) => r.symbol === symbol);
        for (const r of open) {
          lines.push(
            `Open position on ${symbol}: ${r.side} ${r.size} @ ${r.entry}, stop ${r.stopLoss}, target ${r.target} (${r.ref}).`,
          );
        }
      } catch {
        /* snapshot/news optional — context degrades gracefully */
      }
    }

    if (mentionsOpenPositions(text) || symbols.length === 0) {
      const open = this.recommendations.openPositions();
      if (open.length) {
        lines.push("", "Open positions:");
        for (const r of open) {
          lines.push(
            `• ${r.ref} ${r.symbol} ${r.side} ${r.size} @ ${r.entry}, stop ${r.stopLoss}, target ${r.target}.`,
          );
        }
      } else if (mentionsOpenPositions(text)) {
        lines.push("", "No open positions right now.");
      }
    }

    return lines.join("\n");
  }

  /**
   * Per-trade conversation: answer a free-form follow-up about ONE specific
   * recommendation (e.g. "why not buy now?", "where should I enter?"). Feeds the
   * trade's full secret-free context to Claude. ADVISORY ONLY — it can never
   * place, approve, or modify the trade. Works offline (Claude returns a stub).
   */
  async discussTrade(
    ref: string,
    question: string,
  ): Promise<{ ref: string; question: string; answer: string }> {
    const rec =
      this.recommendations.findByRef(ref) ?? this.recommendations.get(ref);
    if (!rec) {
      return {
        ref,
        question,
        answer: `No recommendation found for "${ref}". Use /last_signal to see recent trades.`,
      };
    }
    const context = [await this.askContext(), "", buildTradeContext(rec)].join(
      "\n",
    );
    const answer = await this.claude.ask(question, context);
    await this.audit.log("trade.discuss", "operator", {
      ref: rec.ref,
      symbol: rec.symbol,
      question: question.slice(0, 120),
    });
    return { ref: rec.ref, question, answer };
  }

  /**
   * "What if?" mode: recompute a trade's risk/reward (and expectancy) under a
   * scenario like "move my stop to X", "only one contract", or "win rate 40%".
   * The numbers are deterministic (no AI key needed); when Claude is configured
   * it adds a short interpretation. Never alters the live trade.
   */
  async whatIf(
    ref: string,
    scenario: string,
  ): Promise<WhatIfResult & { interpretation?: string }> {
    const rec =
      this.recommendations.findByRef(ref) ?? this.recommendations.get(ref);
    if (!rec) {
      throw new Error(`No recommendation found for "${ref}".`);
    }
    const result = computeWhatIf(rec, scenario);
    await this.audit.log("trade.whatif", "operator", {
      ref: rec.ref,
      symbol: rec.symbol,
      scenario: scenario.slice(0, 120),
      baseRr: result.base.rr,
      adjustedRr: result.adjusted.rr,
    });
    // Optional AI prose layered on top of the deterministic figures.
    if (this.claude.enabled && result.changes.length > 0) {
      const interpretation = await this.claude.ask(
        `Scenario: ${scenario}\nInterpret this what-if for the operator in 1-2 sentences. Do not invent numbers.`,
        [
          buildTradeContext(rec),
          "",
          "Deterministic recompute:",
          result.summary,
        ].join("\n"),
      );
      return { ...result, interpretation };
    }
    return result;
  }

  /**
   * Debate Mode: build a Bull Case / Bear Case / Final Verdict for a specific
   * recommendation (by ref) or a bare symbol. Deterministic structure (works
   * with no AI key); Claude, when enabled, adds a short closing thought without
   * changing the verdict. ADVISORY ONLY — never places or approves a trade.
   */
  async debate(
    refOrSymbol: string,
  ): Promise<DebateResult & { interpretation?: string }> {
    const thresholds = {
      minScore: this.config.notifications.opportunityAlertScore,
      minRR: this.config.scheduler.minRewardRisk,
    };
    const rec = this.recommendations.findByRef(refOrSymbol);
    const symbol = (rec?.symbol ?? refOrSymbol).toUpperCase();
    let snapshot: MarketSnapshot | null = null;
    let components: ReturnType<typeof scoreSnapshot>["components"] | null =
      null;
    let score: number | null = rec?.avrrioScore ?? null;
    let newsState: { blocked: boolean; reason: string } | null = rec
      ? rec.news
      : null;
    try {
      snapshot = await this.snapshot(symbol);
      const news = await this.news.assess(symbol);
      const scored = scoreSnapshot(snapshot, news.blocked);
      components = scored.components;
      if (score == null) score = scored.score;
      if (!newsState)
        newsState = { blocked: news.blocked, reason: news.reason };
    } catch {
      /* snapshot/news optional — debate degrades to whatever the rec carries */
    }

    const result = buildDebate({
      symbol,
      side: rec?.side ?? null,
      score,
      rr: rec?.rewardRiskRatio ?? null,
      consensus: rec?.consensus ?? null,
      news: newsState,
      components,
      structure: snapshot?.structure ?? null,
      last: snapshot?.quote.last ?? null,
      thresholds,
    });

    await this.audit.log("trade.debate", "operator", {
      ref: rec?.ref,
      symbol,
      verdict: result.verdict,
      confidence: result.confidence,
    });

    if (this.claude.enabled) {
      const context = [
        rec ? buildTradeContext(rec) : `Symbol: ${symbol}`,
        "",
        "Deterministic debate:",
        result.summary,
      ].join("\n");
      const interpretation = await this.claude.ask(
        "In one or two sentences, what is the single most important thing for the operator to weigh here? Do not change the verdict or invent numbers.",
        context,
      );
      return { ...result, interpretation };
    }
    return result;
  }

  /**
   * Trade Coach: review a specific trade (by ref) against the operator's own
   * discipline rules. Deterministic critique (works with no AI key); Claude, when
   * enabled, adds a short coaching note. ADVISORY reflection only.
   */
  async coachTrade(
    ref: string,
  ): Promise<CoachReview & { interpretation?: string }> {
    const rec =
      this.recommendations.findByRef(ref) ?? this.recommendations.get(ref);
    if (!rec) throw new Error(`No recommendation found for "${ref}".`);
    const review = await this.buildCoachReview(rec);
    await this.audit.log("trade.coach", "operator", {
      ref: rec.ref,
      symbol: rec.symbol,
      grade: review.grade,
      critiques: review.critiques.length,
    });
    if (this.claude.enabled) {
      const interpretation = await this.claude.ask(
        "Give one short, encouraging coaching takeaway for next time. Do not invent numbers or add new critiques.",
        [buildTradeContext(rec), "", "Coach review:", review.summary].join(
          "\n",
        ),
      );
      return { ...review, interpretation };
    }
    return review;
  }

  /** Assemble a coach review for a recommendation (pulls structure + outcome). */
  private async buildCoachReview(rec: Recommendation): Promise<CoachReview> {
    let structure: MarketSnapshot["structure"] | null = null;
    let last: number | null = null;
    try {
      const snapshot = await this.snapshot(rec.symbol);
      structure = snapshot.structure;
      last = snapshot.quote.last;
    } catch {
      /* snapshot optional */
    }
    // Realized outcome, if this trade has been closed in the paper journal.
    let outcome: { realizedPnl: number | null; paper: boolean } | null = null;
    const closed = this.journal
      .list()
      .find(
        (e) =>
          e.symbol === rec.symbol &&
          e.status === "closed" &&
          e.realizedPnl != null,
      );
    if (closed)
      outcome = { realizedPnl: closed.realizedPnl ?? null, paper: true };

    return coachReview({
      ref: rec.ref,
      symbol: rec.symbol,
      side: rec.side,
      entry: rec.entry,
      stopLoss: rec.stopLoss,
      target: rec.target,
      rr: rec.rewardRiskRatio,
      score: rec.avrrioScore,
      consensus: rec.consensus,
      news: rec.news,
      overrodeConsensus: !this.consensusSupported(rec),
      thresholds: {
        minScore: this.config.notifications.opportunityAlertScore,
        minRR: this.config.scheduler.minRewardRisk,
      },
      structure,
      last,
      outcome,
    });
  }

  /**
   * Fire-and-forget post-trade review: after a trade is taken, build the coach
   * review and push it to Telegram. Never throws into the execution path.
   */
  private async autoCoach(rec: Recommendation): Promise<void> {
    try {
      const review = await this.buildCoachReview(rec);
      await this.audit.log("trade.coach.auto", "system", {
        ref: rec.ref,
        symbol: rec.symbol,
        grade: review.grade,
      });
      await this.broadcast(review.summary, "trade.coach");
    } catch (err) {
      console.error("autoCoach failed (non-fatal):", err);
    }
  }

  /**
   * Live Trade Management: re-analyzes every open (executed, not yet closed)
   * position and alerts the operator only when the recommended action changes
   * (Hold/Tighten Stop/Take Partial/Exit) — never re-sends the same action on
   * every cycle. Purely advisory: it never modifies or closes an order itself.
   */
  async reviewOpenPositions(): Promise<void> {
    for (const rec of this.recommendations.openPositions()) {
      try {
        await this.reviewOpenPosition(rec);
      } catch (err) {
        console.error(
          `reviewOpenPositions failed for ${rec.ref} (non-fatal):`,
          err,
        );
      }
    }
  }

  private async reviewOpenPosition(rec: Recommendation): Promise<void> {
    const snapshot = await this.snapshot(rec.symbol);
    const signal = assessPosition({
      side: rec.side,
      entry: rec.entry,
      stopLoss: rec.stopLoss,
      target: rec.target,
      last: snapshot.quote.last,
      trend: snapshot.structure.trend,
    });

    if (signal.action === rec.lastManagementAction) return; // no change, no noise

    rec.lastManagementAction = signal.action;
    if (signal.action === "exit")
      rec.managementClosedAt = new Date().toISOString();
    await this.recommendations.update(rec);

    await this.audit.log("trade.management", "system", {
      ref: rec.ref,
      symbol: rec.symbol,
      action: signal.action,
      rMultiple: signal.rMultiple,
    });
    await this.broadcast(
      managementText(rec.ref, rec.symbol, signal),
      "trade.management",
    );
  }

  /** Operator marks an open position as closed — stops further management alerts. */
  async closePosition(idOrRef: string, actor: string): Promise<Recommendation> {
    const rec = this.recommendations.get(idOrRef);
    if (!rec) throw new Error(`No recommendation found for "${idOrRef}".`);
    rec.managementClosedAt = new Date().toISOString();
    await this.recommendations.update(rec);
    await this.audit.log("trade.management.closed", actor, { ref: rec.ref });
    return rec;
  }

  /**
   * Full per-component "why" breakdown for any single symbol — not just the
   * top 3 near-misses a scan cycle tracks. Read-only — never proposes a trade.
   */
  async explainSymbol(symbolInput: string): Promise<SymbolExplanation> {
    const symbol = symbolInput.trim().toUpperCase();
    const snapshot = await this.snapshot(symbol);
    const news = await this.news.assess(symbol);
    const { score, components } = scoreSnapshot(snapshot, news.blocked);
    const tradable = isTradable(symbol);
    const direction =
      snapshot.structure.trend === "up"
        ? "bullish"
        : snapshot.structure.trend === "down"
          ? "bearish"
          : "reversal";
    const side: Side | null =
      direction === "bullish"
        ? "long"
        : direction === "bearish"
          ? "short"
          : null;

    let rewardRisk: number | null = null;
    let duplicateOpen = false;
    if (side && tradable) {
      const levels = suggestLevels(snapshot, side);
      rewardRisk =
        Math.abs(levels.target - levels.entry) /
        Math.max(1e-9, Math.abs(levels.entry - levels.stopLoss));
      duplicateOpen = this.recommendations.hasOpenDuplicate(symbol, side);
    }

    return explainSymbol({
      symbol,
      tradable,
      score,
      minScore: this.config.notifications.opportunityAlertScore,
      components,
      direction,
      newsBlocked: news.blocked,
      newsReason: news.reason,
      rewardRisk,
      minRewardRisk: this.config.scheduler.minRewardRisk,
      duplicateOpen,
    });
  }

  async explainSymbolText(symbol: string): Promise<string> {
    return explainSymbolText(await this.explainSymbol(symbol));
  }

  /**
   * Ranks EVERY symbol in the universe by Avrrio Score, best to worst — not
   * just the top alerts or near-misses. Read-only; never proposes a trade.
   */
  async rankMarkets(): Promise<MarketRank[]> {
    const minScore = this.config.notifications.opportunityAlertScore;
    const minRR = this.config.scheduler.minRewardRisk;
    const results = await this.scan(); // already sorted by score, desc.

    const ranks: MarketRank[] = [];
    let rank = 0;
    for (const r of results) {
      rank++;
      const side: Side | null =
        r.direction === "bullish"
          ? "long"
          : r.direction === "bearish"
            ? "short"
            : null;

      let rewardRisk: number | null = null;
      let duplicateOpen = false;
      if (side && r.tradable) {
        try {
          const snapshot = await this.snapshot(r.symbol);
          const levels = suggestLevels(snapshot, side);
          rewardRisk =
            Math.abs(levels.target - levels.entry) /
            Math.max(1e-9, Math.abs(levels.entry - levels.stopLoss));
          duplicateOpen = this.recommendations.hasOpenDuplicate(r.symbol, side);
        } catch {
          /* reward/risk optional if a snapshot fetch fails */
        }
      }

      ranks.push(
        rankMarket(
          {
            symbol: r.symbol,
            name: r.name,
            tradable: r.tradable,
            score: r.score,
            minScore,
            direction: r.direction,
            newsBlocked: r.newsBlocked,
            rewardRisk,
            minRewardRisk: minRR,
            duplicateOpen,
          },
          rank,
        ),
      );
    }
    return ranks;
  }

  async rankMarketsText(): Promise<string> {
    return rankMarketsText(await this.rankMarkets());
  }

  /**
   * Explains the latest scan: which filters each top symbol failed and the
   * global gates. Read-only. Covers score, reward/risk, tradability, direction,
   * news, emergency stop, daily-loss budget, and duplicate positions.
   */
  async scanExplanation(): Promise<string> {
    const minScore = this.config.notifications.opportunityAlertScore;
    const minRR = this.config.scheduler.minRewardRisk;
    // Read-only: explain the most recent scan. If none has run yet, run one
    // (it never forces a trade). Callers wanting freshness run a cycle first.
    if (!this.scheduler.lastScan()) await this.scheduler.runScanCycle();
    const last = this.scheduler.lastScan();
    const lines = [
      "🤔 WHY NO TRADE",
      `Filters: Avrrio score ≥ ${minScore}, reward/risk ≥ ${minRR}, futures only. (Filters are intentionally strict — quality over activity.)`,
      `Emergency Stop: ${this.killSwitch.isEngaged() ? "ENGAGED — all trades blocked 🛑" : "clear"}`,
    ];
    try {
      const a = await this.getAccount();
      const remaining = a.rules.maxDailyLoss - Math.max(0, -a.dayPnl);
      lines.push(
        `Daily-loss budget: day P&L ${a.dayPnl >= 0 ? "+" : ""}$${a.dayPnl}, $${remaining.toFixed(0)} of $${a.rules.maxDailyLoss} remaining.`,
      );
    } catch {
      /* account snapshot optional */
    }

    if (last && last.alerted > 0) {
      lines.push(
        "",
        `✅ ${last.alerted} A+ setup(s) alerted: ${last.refs.join(", ")}.`,
      );
      return lines.join("\n");
    }

    const near = last?.nearMisses ?? [];
    const tradableNear = near.filter((n) => n.tradable);
    const watchlistNear = near.filter((n) => !n.tradable);

    lines.push("", "No A+ setup right now.");
    if (tradableNear.length) {
      lines.push("Top near-miss setups:");
      for (const n of tradableNear) {
        lines.push(
          `• ${n.symbol} ${(n.side ?? "").toUpperCase()} — score ${n.score}${n.rr != null ? `, R:R ${n.rr}` : ""} — needs: ${n.reasons.join(", ") || "—"}`,
        );
      }
    }
    if (watchlistNear.length) {
      lines.push(
        "Closest watchlist candidates (analysis-only): " +
          watchlistNear.map((n) => `${n.symbol} (score ${n.score})`).join(", "),
      );
    }
    if (!tradableNear.length && !watchlistNear.length) {
      lines.push("Nothing close — market is quiet or filtered out.");
    }
    lines.push(
      "",
      "Filters are not lowered to manufacture a trade. A qualifying setup still needs your approval; AI consensus + full risk stack run at approval time.",
    );
    return lines.join("\n");
  }

  /** Sends the 🚨 signal SMS with YES/NO reply instructions, and audits it. */
  private async sendSignalSms(rec: Recommendation): Promise<void> {
    if (!this.config.notifications.sms.enabled) return;
    const result = await sendSms(this.config, formatSignalSms(rec));
    await this.audit.log("sms.signal_sent", "system", {
      ref: rec.ref,
      ok: result.ok,
      info: result.info,
    });
  }

  /** True when AI consensus endorses this trade's direction (≥1 model agrees). */
  private consensusSupported(rec: Recommendation): boolean {
    const c = rec.consensus;
    return c.recommendation === rec.side && c.agreement >= 1;
  }

  /**
   * Whether approving this recommendation would override an unsupportive AI
   * consensus (no-trade / abstain / opposite). Used by the dashboard to prompt
   * for an explicit confirmation before approving against the AI.
   */
  approvalOverrideInfo(id: string): {
    overrideRequired: boolean;
    recommendation: string;
    agreement: number;
    available: number;
  } {
    const rec = this.recommendations.get(id);
    if (!rec) throw new Error(`Recommendation ${id} not found.`);
    return {
      overrideRequired: !this.consensusSupported(rec),
      recommendation: rec.consensus.recommendation,
      agreement: rec.consensus.agreement,
      available: rec.consensus.available,
    };
  }

  /**
   * Approve a recommendation.
   * - `immediate` (Mode 1, Manual): execute right away.
   * - `pre-approved` (Mode 2): arm it; the maintenance loop executes it when the
   *   entry is reached AND risk/news/kill-switch still pass, before it expires.
   *
   * `override` is required to approve a trade the AI consensus does not endorse;
   * without it, approval is refused so a human can't override the AI by accident.
   */
  async approve(
    id: string,
    actor: string,
    mode: ApprovalMode = "immediate",
    override = false,
  ): Promise<{ mode: ApprovalMode; armed: boolean; result?: OrderResult }> {
    const rec = this.requireLiveRec(id);
    // Advisor mode: never place an order. Leave the recommendation untouched
    // (still pending, so it can be entered manually) and surface a clean
    // acknowledgement rather than persisting it as "blocked" via the executor.
    if (this.settings.getTradingMode() === "advisor") {
      await this.audit.log("approve.advisor_only", actor, {
        recommendationId: rec.id,
        ref: rec.ref,
      });
      throw new Error(
        `Advisor mode: Avrrio does not place orders. Enter ${rec.ref} manually in TopstepX if you want it.`,
      );
    }
    // Consensus override guard: refuse to approve against an unsupportive AI
    // consensus unless the operator explicitly confirms the override.
    if (!this.consensusSupported(rec)) {
      const c = rec.consensus;
      if (!override) {
        await this.audit.log("approve.override_required", actor, {
          recommendationId: rec.id,
          ref: rec.ref,
          consensus: c.recommendation,
          agreement: c.agreement,
        });
        throw new Error(
          `OVERRIDE_REQUIRED: AI consensus is "${c.recommendation}" (agreement ${c.agreement}/${c.available}). Re-approve with override to proceed.`,
        );
      }
      await this.audit.log("approve.consensus_override", actor, {
        recommendationId: rec.id,
        ref: rec.ref,
        consensus: c.recommendation,
        agreement: c.agreement,
      });
    }
    rec.approvalMode = mode;
    rec.decidedBy = actor;
    rec.decidedAt = new Date().toISOString();

    if (mode === "pre-approved") {
      rec.status = "armed";
      await this.recommendations.update(rec);
      await this.audit.log("recommendation.armed", actor, {
        recommendationId: rec.id,
        expiresAt: rec.expiresAt,
      });
      // It may already satisfy its conditions — try once immediately.
      const result = await this.tryTrigger(rec);
      return {
        mode,
        armed: result === undefined,
        ...(result ? { result } : {}),
      };
    }

    const result = await this.executor.execute(rec, actor);
    if (result.paper)
      await this.settings.markValidation("paperApprovalTestPassed");
    if (result.accepted) void this.autoCoach(rec); // post-trade review
    return { mode, armed: false, result };
  }

  async reject(id: string, actor: string, reason = ""): Promise<void> {
    const rec = this.recommendations.get(id);
    if (!rec) throw new Error(`Recommendation ${id} not found.`);
    await this.executor.reject(rec, actor, reason);
  }

  /** Token-gated approval used by notification links (no dashboard login). */
  approveByToken(id: string, token: string, mode: ApprovalMode) {
    const rec = this.requireLiveRec(id);
    if (rec.approvalToken !== token) throw new Error("Invalid approval token.");
    // A tokenized link click is a deliberate human action — allow the override
    // (it is audited as approve.consensus_override when consensus disagrees).
    return this.approve(id, "phone", mode, true);
  }

  async rejectByToken(id: string, token: string): Promise<void> {
    const rec = this.recommendations.get(id);
    if (!rec || rec.approvalToken !== token) {
      throw new Error("Invalid approval token.");
    }
    await this.executor.reject(rec, "phone", "rejected via link");
  }

  /**
   * Maintenance tick: expire stale pending/armed recommendations and execute any
   * armed (pre-approved) trade whose entry has been reached and whose risk/news/
   * kill-switch checks still pass. Call this on an interval.
   */
  async maintain(): Promise<void> {
    const now = Date.now();
    for (const rec of this.recommendations.list()) {
      if (rec.status !== "pending" && rec.status !== "armed") continue;
      if (rec.expiresAt && now > new Date(rec.expiresAt).getTime()) {
        rec.status = "expired";
        await this.recommendations.update(rec);
        await this.audit.log("recommendation.expired", "system", {
          recommendationId: rec.id,
        });
      }
    }
    for (const rec of this.recommendations.armed()) {
      await this.tryTrigger(rec);
    }
  }

  private requireLiveRec(id: string): Recommendation {
    const rec = this.recommendations.get(id);
    if (!rec) throw new Error(`Recommendation ${id} not found.`);
    if (rec.expiresAt && Date.now() > new Date(rec.expiresAt).getTime()) {
      throw new Error("Recommendation has expired.");
    }
    return rec;
  }

  /**
   * If an armed trade's entry is reached and all conditions still pass, execute
   * it and return the order result; otherwise return undefined (stays armed).
   */
  private async tryTrigger(
    rec: Recommendation,
  ): Promise<OrderResult | undefined> {
    if (rec.status !== "armed") return undefined;

    const quote = await this.client.getQuote(rec.symbol);
    const tol = this.config.queue.entryTriggerTolerancePct;
    const reached =
      rec.entry === 0 || Math.abs(quote.last - rec.entry) / rec.entry <= tol;
    if (!reached) return undefined;

    // Re-check live conditions before pulling the trigger.
    const account = await this.getAccount();
    const news = await this.news.assess(rec.symbol);
    const context: RiskContext = {
      symbolTradable: isTradable(rec.symbol),
      killSwitchEngaged: this.killSwitch.isEngaged(),
      news,
      tradesToday: this.recommendations.executedToday(),
      safety: {
        maxPositionSize: this.config.safety.maxPositionSize,
        maxTradesPerDay: this.config.safety.maxTradesPerDay,
        maxRiskPerTrade: this.config.safety.maxRiskPerTrade,
        maxDailyLoss: this.config.safety.dailyMaxLoss,
      },
    };
    const recheck = this.risk.assess(rec, account, context);
    if (!recheck.approved) {
      await this.audit.log("pre_approved.trigger_blocked", "system", {
        recommendationId: rec.id,
        reasons: recheck.violations.map((v) => v.rule),
      });
      return undefined; // stay armed; will expire if conditions never clear
    }

    const result = await this.executor.execute(rec, "system(pre-approved)");
    if (result.accepted) void this.autoCoach(rec); // post-trade review
    return result;
  }

  async engageKill(reason: string, actor: string): Promise<void> {
    await this.killSwitch.engage(reason, actor);
    await this.settings.markValidation("emergencyStopTested");
    if (this.config.notifications.sms.enabled) {
      const r = await sendSms(
        this.config,
        "🛑 Emergency Stop activated. No trades can execute.",
      );
      await this.audit.log("sms.emergency_sent", actor, {
        ok: r.ok,
        info: r.info,
      });
    }
  }

  disengageKill(actor: string) {
    return this.killSwitch.disengage(actor);
  }

  // --- TopstepX connection ----------------------------------------------
  topstepxStatus(): TopstepStatus {
    return this.client.status();
  }
  topstepxConnect(): Promise<TopstepStatus> {
    return this.client.connect();
  }
  topstepxDisconnect(): TopstepStatus {
    return this.client.disconnect();
  }
  topstepxSync(): Promise<TopstepStatus> {
    return this.client.sync();
  }
  async topstepxAuthTest(): Promise<AuthTestResult> {
    const r = await this.client.authTest();
    this.lastAuthTest = r;
    return r;
  }

  // --- runtime trading mode (paper/live) toggle -------------------------
  isLiveTradingEnabled(): boolean {
    return this.settings.isLiveTradingEnabled();
  }
  async setLiveTrading(enabled: boolean, actor: string): Promise<void> {
    if (enabled) {
      const checklist = await this.liveTradingChecklist(true);
      if (!checklist.ready) {
        await this.audit.log("settings.live_trading_blocked", actor, {
          blockers: checklist.blockers,
        });
        throw new Error(
          `Live trading is locked until all checks pass: ${checklist.blockers.join("; ")}`,
        );
      }
    }
    await this.settings.setLiveTrading(enabled);
    await this.audit.log("settings.live_trading", actor, { enabled });
    if (enabled) {
      // Explicit, audited milestone + operator alert when going live.
      await this.audit.log("live_trading_enabled", actor, {
        tradingMode: this.settings.getTradingMode(),
        maxPositionSize: this.config.safety.maxPositionSize,
        accountId: this.client.status().accountId,
      });
      await this.broadcast(
        "🟢 Avrrio Trade AI — LIVE TRADING ENABLED.\n" +
          `Mode: ${this.settings.getTradingMode()} · max size: ${this.config.safety.maxPositionSize} · human approval required for every trade.`,
        "live_enabled",
      );
    } else {
      await this.broadcast(
        "⚪ Avrrio Trade AI — live trading disabled (back to paper).",
        "live_disabled",
      );
    }
  }

  async liveTradingChecklist(
    refreshAuth = false,
  ): Promise<LiveTradingChecklist> {
    if (refreshAuth) {
      this.lastAuthTest = await this.client.authTest();
    }
    const auth = this.lastAuthTest;
    const status = this.client.status();
    const v = this.settings.getValidations();
    const maxDailyLossConfigured =
      this.config.safety.dailyMaxLoss > 0 || status.maxDailyLoss > 0;
    const maxPositionSizeConfigured = this.config.safety.maxPositionSize > 0;
    const checks: Array<
      [keyof Omit<LiveTradingChecklist, "ready" | "blockers">, boolean, string]
    > = [
      ["projectxAuth", !!auth?.ok, "ProjectX auth must pass"],
      [
        "tokenReceived",
        !!auth?.tokenReceived,
        "Auth Test must show token received yes",
      ],
      [
        "accountFound",
        !!auth?.accountFound,
        "Auth Test must show account found yes",
      ],
      ["telegramTestPassed", v.telegramTestPassed, "Telegram test must pass"],
      [
        "emergencyStopTested",
        v.emergencyStopTested,
        "Emergency Stop must be tested",
      ],
      [
        "maxDailyLossConfigured",
        maxDailyLossConfigured,
        "Max daily loss must be configured",
      ],
      [
        "maxPositionSizeConfigured",
        maxPositionSizeConfigured,
        "Max position size must be configured",
      ],
      [
        "paperApprovalTestPassed",
        v.paperApprovalTestPassed,
        "At least one paper/simulated approval test must succeed",
      ],
    ];
    const blockers = checks.filter(([, ok]) => !ok).map(([, , label]) => label);
    return {
      projectxAuth: !!auth?.ok,
      tokenReceived: !!auth?.tokenReceived,
      accountFound: !!auth?.accountFound,
      telegramTestPassed: v.telegramTestPassed,
      emergencyStopTested: v.emergencyStopTested,
      maxDailyLossConfigured,
      maxPositionSizeConfigured,
      paperApprovalTestPassed: v.paperApprovalTestPassed,
      ready: blockers.length === 0,
      blockers,
    };
  }

  /** Clear the operator-completed safety validations so they must be re-tested. */
  async resetSafetyValidations(actor: string): Promise<void> {
    await this.settings.resetValidations();
    await this.audit.log("safety.validations_reset", actor, {});
  }

  /**
   * Consolidated readiness report: re-checks auth live, folds in the persisted
   * validations + risk-limit config + account-sync snapshot, and scores overall
   * readiness. Read-only — never enables live trading or places an order.
   */
  async readinessReport(refreshAuth = true): Promise<ReadinessReport> {
    const c = await this.liveTradingChecklist(refreshAuth);
    const s = this.client.status();
    const items = [
      c.projectxAuth,
      c.tokenReceived,
      c.accountFound,
      c.telegramTestPassed,
      c.emergencyStopTested,
      c.maxDailyLossConfigured,
      c.maxPositionSizeConfigured,
      c.paperApprovalTestPassed,
    ];
    const passed = items.filter(Boolean).length;
    const total = items.length;
    return {
      projectxAuth: c.projectxAuth && c.tokenReceived && c.accountFound,
      accountSync: {
        connected: s.connected && s.authenticated,
        accountId: s.accountId,
        buyingPower: s.availableBuyingPower,
        dailyPnL: s.dailyPnL,
        lastSyncTime: s.lastSyncTime,
      },
      telegram: c.telegramTestPassed,
      emergencyStop: c.emergencyStopTested,
      riskLimits: {
        dailyLoss: c.maxDailyLossConfigured,
        positionSize: c.maxPositionSizeConfigured,
      },
      paperApproval: c.paperApprovalTestPassed,
      blockers: c.blockers,
      passed,
      total,
      scorePct: Math.round((passed / total) * 100),
      liveTradingEnabled: this.isLiveTradingEnabled(),
      ready: c.ready,
    };
  }

  /** Telegram/console-friendly readiness summary (no secrets). */
  readinessReportText(r: ReadinessReport): string {
    const yn = (b: boolean) => (b ? "✅" : "⚠️");
    return [
      "📋 AVRRIO LIVE-TRADING READINESS",
      "",
      `${yn(r.projectxAuth)} ProjectX auth (token + account)`,
      `${yn(r.accountSync.connected)} Account sync — ID ${r.accountSync.accountId || "—"} · BP $${r.accountSync.buyingPower.toLocaleString()} · Day P&L ${r.accountSync.dailyPnL >= 0 ? "+" : ""}$${r.accountSync.dailyPnL.toLocaleString()}`,
      `${yn(r.telegram)} Telegram alert test`,
      `${yn(r.emergencyStop)} Emergency Stop tested`,
      `${yn(r.riskLimits.dailyLoss)} Max daily loss configured`,
      `${yn(r.riskLimits.positionSize)} Max position size configured`,
      `${yn(r.paperApproval)} Paper approval workflow`,
      "",
      `Score: ${r.passed}/${r.total} (${r.scorePct}%)`,
      `Live trading: ${r.liveTradingEnabled ? "ENABLED" : "disabled"} · Overall: ${r.ready ? "READY" : "NOT READY"}`,
      r.blockers.length
        ? `Blockers: ${r.blockers.join("; ")}`
        : "No blockers remaining.",
    ].join("\n");
  }

  /** Build + broadcast the readiness report to the operator's channels. */
  async sendReadinessReport(actor: string): Promise<ReadinessReport> {
    const report = await this.readinessReport(true);
    await this.broadcast(this.readinessReportText(report), "readiness");
    await this.audit.log("readiness.sent", actor, {
      score: report.scorePct,
      ready: report.ready,
    });
    return report;
  }

  // --- trading mode (advisor / telegram_approval / full_auto) -----------
  getTradingMode(): TradingMode {
    return this.settings.getTradingMode();
  }
  async setTradingMode(mode: TradingMode, actor: string): Promise<void> {
    await this.settings.setTradingMode(mode);
    await this.audit.log("settings.trading_mode", actor, { mode });
  }

  /** Exact SMS env vars that are missing (empty when fully configured). */
  smsMissing(): string[] {
    return smsMissing(this.config);
  }

  async setScheduler(
    enabled: boolean,
    intervalMinutes: number | undefined,
    actor: string,
  ): Promise<void> {
    await this.scheduler.configure(enabled, intervalMinutes);
    await this.audit.log("settings.scheduler", actor, {
      enabled,
      intervalMinutes,
    });
  }

  /**
   * Execute a stored recommendation by id/ref, gated on TopstepX readiness.
   * In LIVE mode the broker must be connected, authenticated, and active; in
   * paper mode a simulated fill is allowed so the workflow is testable.
   */
  async executeRecommendation(idOrRef: string, actor: string) {
    const rec = this.requireLiveRec(idOrRef);
    this.assertBrokerReady();
    return this.executor.execute(rec, actor);
  }

  private assertBrokerReady(): void {
    if (!this.settings.isLiveTradingEnabled()) return; // paper is fine
    const s = this.client.status();
    if (!s.connected || !s.authenticated || s.accountStatus !== "active") {
      throw new Error("TopstepX is not connected/authenticated.");
    }
  }

  // --- SMS: outbound test + inbound command handling --------------------
  async sendTestSms() {
    const r = await sendSms(
      this.config,
      "Avrrio Trade AI test alert successful.",
    );
    await this.audit.log("sms.test_sent", "operator", {
      ok: r.ok,
      info: r.info,
    });
    return r;
  }

  /** Send a free-text SMS to the alert number (used for the daily summary). */
  async notifyText(text: string, type = "sms.notify"): Promise<void> {
    if (!this.config.notifications.sms.enabled) return;
    const r = await sendSms(this.config, text);
    await this.audit.log(type, "system", { ok: r.ok, info: r.info });
  }

  /**
   * Broadcast a free-text message to the operator's alert channels. Telegram is
   * primary; SMS is sent too when enabled. Used for scheduled day reports.
   */
  async broadcast(text: string, type = "report"): Promise<void> {
    if (this.telegram.enabled) {
      const r = await this.telegram.sendText(text);
      await this.audit.log(`${type}.telegram`, "system", {
        ok: r.ok,
        info: r.info,
      });
    }
    if (this.config.notifications.sms.enabled) {
      const r = await sendSms(this.config, text);
      await this.audit.log(`${type}.sms`, "system", { ok: r.ok, info: r.info });
    }
  }

  /**
   * Build + send a scheduled day report (morning / midday / closing) to the
   * operator's channels. Read-only — never places or modifies trades.
   */
  async sendScheduledReport(
    slot: "morning" | "midday" | "closing",
    scans: number,
  ): Promise<string> {
    const text =
      slot === "closing"
        ? this.dailySummaryText(scans)
        : await this.buildReport(slot, scans);
    await this.broadcast(text, `report.${slot}`);
    return text;
  }

  /** Morning/midday report: account snapshot + today's best opportunities. */
  private async buildReport(
    slot: "morning" | "midday",
    scans: number,
  ): Promise<string> {
    // Title reflects the ACTUAL local time-of-day (ACCOUNT_TIMEZONE, else server
    // local) — not the scheduler slot — so a report at 8am isn't labelled MIDDAY.
    const header = reportTitle(localHour(this.config.accountTimezone));
    let account: AccountSummary | null = null;
    try {
      account = await this.getAccount();
    } catch {
      /* report still useful without the account snapshot */
    }
    const top = (await this.scan({ limit: 12 }))
      .filter(
        (r) =>
          r.tradable &&
          (r.direction === "bullish" || r.direction === "bearish"),
      )
      .slice(0, 3);
    const lines = [
      header,
      `Mode: ${this.getTradingMode()} · Trading: ${this.isLiveTradingEnabled() ? "LIVE" : "paper"}`,
    ];
    if (account) {
      lines.push(
        `Account: ${account.name} · BP $${account.balance.toLocaleString()} · Day P&L ${account.dayPnl >= 0 ? "+" : ""}$${account.dayPnl.toLocaleString()}`,
      );
    }
    lines.push(
      `Kill switch: ${this.killSwitch.isEngaged() ? "ENGAGED" : "clear"}`,
    );
    if (slot === "midday") lines.push(`Scans today: ${scans}`);
    lines.push(
      "",
      top.length ? "Top opportunities:" : "No tradable setups right now.",
    );
    for (const o of top) {
      lines.push(
        `• ${o.symbol} ${o.direction === "bullish" ? "LONG" : "SHORT"} — score ${o.score}/100`,
      );
    }
    // Near-miss feedback from the latest scan (quality over activity).
    const near = this.scheduler.lastScan()?.nearMisses ?? [];
    const tradableNear = near.filter((n) => n.tradable && n.side);
    if (tradableNear.length) {
      lines.push("", "Near-miss (not A+ yet):");
      for (const n of tradableNear) {
        lines.push(
          `• ${n.symbol} ${(n.side ?? "").toUpperCase()} — score ${n.score}${n.rr != null ? `, R:R ${n.rr}` : ""} — needs: ${n.reasons.join(", ") || "—"}`,
        );
      }
    } else if (!top.length) {
      const watchlist = near.filter((n) => !n.tradable);
      if (watchlist.length) {
        lines.push(
          "No A+ setup. Closest watchlist candidates: " +
            watchlist.map((n) => `${n.symbol} (${n.score})`).join(", "),
        );
      }
    }
    return lines.join("\n");
  }

  /** Build the end-of-day report from today's recommendations + journal. */
  dailySummaryText(scans: number): string {
    const today = new Date().toISOString().slice(0, 10);
    const todays = this.recommendations
      .list()
      .filter((r) => r.createdAt.slice(0, 10) === today);
    const signals = todays.length;
    const approved = todays.filter(
      (r) => r.status === "executed" || r.status === "approved",
    ).length;
    const rejected = todays.filter((r) => r.status === "rejected").length;
    const stats = this.journal.stats();
    const closed = this.journal
      .list()
      .filter((e) => e.status === "closed" && (e.realizedPnl ?? 0) !== 0);
    const wins = closed.filter((e) => (e.realizedPnl ?? 0) > 0).length;
    const winRate = closed.length ? (wins / closed.length) * 100 : 0;
    return [
      "📊 AVRRIO DAILY REPORT",
      `Scans: ${scans}`,
      `Signals: ${signals}`,
      `Approved: ${approved}`,
      `Rejected: ${rejected}`,
      `Win Rate: ${winRate.toFixed(1)}%`,
      `PnL: ${stats.realizedPnl >= 0 ? "+" : ""}$${stats.realizedPnl.toFixed(0)}`,
    ].join("\n");
  }

  /** Optional alert when a high-confidence scanner opportunity is found. */
  async alertOpportunity(o: {
    symbol: string;
    direction: string;
    score: number;
    confidence: number;
  }): Promise<void> {
    if (!this.config.notifications.sms.enabled) return;
    if (o.score < this.config.notifications.opportunityAlertScore) return;
    const name = findSymbol(o.symbol)?.name ?? o.symbol;
    const r = await sendSms(this.config, formatOpportunitySms({ ...o, name }));
    await this.audit.log("sms.opportunity_sent", "system", {
      symbol: o.symbol,
      score: o.score,
      ok: r.ok,
    });
  }

  /**
   * Handle an inbound SMS reply. Authorizes by phone number, parses the command,
   * applies it through the same safety gates as the dashboard, audits it, and
   * returns the confirmation text to send back.
   */
  async handleInboundSms(fromNumber: string, body: string): Promise<string> {
    const authorized = samePhone(
      fromNumber,
      this.config.notifications.sms.toNumber,
    );
    if (!authorized) {
      await this.audit.log("sms.unauthorized", fromNumber, { body });
      return "⚠️ Unauthorized number. Command rejected.";
    }
    const cmd = parseSmsCommand(body);
    await this.audit.log("sms.command", fromNumber, { cmd });
    return this.applySmsCommand(cmd);
  }

  private async applySmsCommand(cmd: SmsCommand): Promise<string> {
    switch (cmd.type) {
      case "stopall":
        await this.engageKill("SMS STOPALL", "phone");
        return "🛑 Emergency Stop activated. No trades can execute.";
      case "status":
        return this.smsStatusText();
      case "pending":
        return this.smsPendingText();
      case "approve":
        return this.approveBySms(cmd.ref);
      case "reject":
        return this.rejectBySms(cmd.ref);
      default:
        return "Sorry, I didn't understand. Reply YES <id>, NO <id>, STOPALL, STATUS, or PENDING.";
    }
  }

  private telegramDetails(ref: string): string {
    const rec = this.recommendations.findByRef(ref);
    if (!rec) return `⚠️ Trade ${ref} not found.`;
    const rr =
      rec.riskAmount > 0
        ? Math.abs(rec.target - rec.entry) / Math.abs(rec.entry - rec.stopLoss)
        : 0;
    const liveMode = this.settings.isLiveTradingEnabled()
      ? "LIVE"
      : "paper/simulated";
    return [
      `📋 Trade ${rec.ref} details`,
      `${rec.symbol} ${rec.side.toUpperCase()} ×${rec.size}`,
      `Entry ${rec.entry} · Stop ${rec.stopLoss} · Target ${rec.target}`,
      `Risk $${rec.riskAmount.toFixed(0)} · R/R ${Number.isFinite(rr) ? rr.toFixed(1) : "n/a"}`,
      `Status ${rec.status} · Mode ${liveMode}`,
      `Risk checks ${rec.riskApproved ? "passed" : "failed"}`,
      `Live trading remains ${this.settings.isLiveTradingEnabled() ? "enabled" : "locked/off"}.`,
    ].join("\n");
  }

  /**
   * Re-evaluates live risk limits for a recommendation at approval time and
   * returns a human reason if it is locked out (daily-loss budget, position
   * size, per-trade risk, or max trades/day), else null. Read-only.
   */
  private async riskLockoutReason(rec: Recommendation): Promise<string | null> {
    const account = await this.getAccount();
    const context: RiskContext = {
      symbolTradable: isTradable(rec.symbol),
      killSwitchEngaged: this.killSwitch.isEngaged(),
      tradesToday: this.recommendations.executedToday(),
      safety: {
        maxPositionSize: this.config.safety.maxPositionSize,
        maxTradesPerDay: this.config.safety.maxTradesPerDay,
        maxRiskPerTrade: this.config.safety.maxRiskPerTrade,
        maxDailyLoss: this.config.safety.dailyMaxLoss,
      },
    };
    const assessment = this.risk.assess(rec, account, context);
    const lockoutRules = new Set([
      "daily-loss-budget",
      "max-position-size",
      "engine-max-position-size",
      "max-risk-per-trade",
      "max-trades-per-day",
    ]);
    const hit = assessment.violations.filter((v) => lockoutRules.has(v.rule));
    return hit.length ? hit.map((v) => v.message).join("; ") : null;
  }

  /** Sends a Telegram (and SMS, if on) warning that a trade was blocked. */
  private async warnLockout(
    rec: Recommendation,
    reason: string,
    kind: string,
  ): Promise<void> {
    const text = `⚠️ AVRRIO SAFETY BLOCK\nTrade ${rec.ref} (${rec.symbol} ${rec.side.toUpperCase()}) was blocked.\nReason: ${reason}.\nNo order was placed.`;
    await this.broadcast(text, "safety.lockout");
    await this.audit.log("safety.lockout_warned", "system", {
      ref: rec.ref,
      kind,
      reason,
    });
  }

  private async approveBySms(ref: string): Promise<string> {
    const rec = this.recommendations.findByRef(ref);
    if (!rec) return `⚠️ Trade ${ref} not found.`;
    if (this.settings.getTradingMode() === "advisor") {
      await this.audit.log("approve.advisor_only", "phone", { ref });
      return `ℹ️ Advisor mode: Avrrio does not place orders. Enter ${ref} manually in TopstepX if you want it.`;
    }
    if (this.killSwitch.isEngaged()) {
      await this.warnLockout(rec, "Emergency Stop is engaged", "kill-switch");
      return `🛑 Emergency Stop active. Trade ${ref} cannot execute.`;
    }
    if (rec.status !== "pending" && rec.status !== "armed") {
      return `⚠️ Trade ${ref} is ${rec.status} and cannot be approved.`;
    }
    if (rec.expiresAt && Date.now() > new Date(rec.expiresAt).getTime()) {
      rec.status = "expired";
      await this.recommendations.update(rec);
      return `⚠️ Trade ${ref} expired. Approval blocked.`;
    }
    // Re-check live risk limits at approval time: daily-loss lockout, position
    // size, per-trade risk, max trades. Block + warn if any is hit.
    const lockout = await this.riskLockoutReason(rec);
    if (lockout) {
      await this.warnLockout(rec, lockout, "risk-limit");
      return `⚠️ Trade ${ref} blocked by risk limits: ${lockout}.`;
    }
    // Block if the market has moved too far from entry.
    const quote = await this.client.getQuote(rec.symbol);
    const tol = this.config.queue.entryTriggerTolerancePct;
    if (
      rec.entry > 0 &&
      Math.abs(quote.last - rec.entry) / rec.entry > tol * 50
    ) {
      return `⚠️ Trade ${ref} blocked: price moved too far from entry ${rec.entry} (now ${quote.last}).`;
    }
    // TopstepX readiness gate.
    if (this.settings.isLiveTradingEnabled()) {
      const s = this.client.status();
      if (!s.connected || !s.authenticated || s.accountStatus !== "active") {
        await this.audit.log("sms.approve_blocked", "phone", {
          ref,
          reason: "topstepx not connected",
        });
        return `⚠️ Trade ${ref} approved, but execution blocked because TopstepX is not connected.`;
      }
    }
    // Telegram/SMS approval is one-tap; a tap IS the human decision, so we allow
    // the override but flag it clearly when the AI consensus disagrees.
    const overriding = !this.consensusSupported(rec);
    const note = overriding
      ? `⚠️ Override: AI consensus was "${rec.consensus.recommendation}" (agreement ${rec.consensus.agreement}/${rec.consensus.available}).\n`
      : "";
    try {
      const result = await this.approve(rec.id, "phone", "immediate", true);
      return `${note}✅ Trade ${ref} approved. ${result.result?.paper ? "Paper fill" : "Order submitted"} (${result.result?.orderId ?? "pending"}).`;
    } catch (err) {
      return `⚠️ Trade ${ref} could not execute: ${err instanceof Error ? err.message : "error"}`;
    }
  }

  private async rejectBySms(ref: string): Promise<string> {
    const rec = this.recommendations.findByRef(ref);
    if (!rec) return `⚠️ Trade ${ref} not found.`;
    await this.executor.reject(rec, "phone", "rejected via SMS");
    return `❌ Trade ${ref} rejected.`;
  }

  private smsStatusText(): string {
    const t = this.client.status();
    const ks = this.killSwitch.isEngaged() ? "ENGAGED" : "clear";
    return [
      `Avrrio status: ${t.offline ? "demo" : "live"} data`,
      `TopstepX: ${t.connected ? "connected" : "not connected"} (${t.accountStatus})`,
      `Day P&L $${t.dailyPnL} · Pending ${this.recommendations.pending().length}`,
      `Kill switch: ${ks}`,
    ].join("\n");
  }

  private smsPendingText(): string {
    const pending = this.recommendations
      .pending()
      .concat(this.recommendations.armed());
    if (pending.length === 0) return "No pending trades.";
    return pending
      .slice(0, 5)
      .map(
        (r) =>
          `${r.ref}: ${r.symbol} ${r.side.toUpperCase()} @ ${r.entry} (${r.status})`,
      )
      .join("\n");
  }

  async closePaperTrade(id: string, exit: number, symbol: string) {
    const entry = await this.journal.close(id, exit, pointValue(symbol));
    // Feed the outcome into Avrrio Memory so it can learn the operator's habits.
    try {
      await this.recordTradeOutcome({
        symbol,
        side: entry.side,
        pnl: entry.realizedPnl ?? 0,
        entryIso: entry.createdAt,
      });
    } catch (err) {
      console.error("memory record failed (non-fatal):", err);
    }
    return entry;
  }

  /**
   * Record a completed trade into Avrrio Memory, enriching it from the matching
   * executed recommendation (setup, score, reward/risk) when one exists. Memory
   * is descriptive only — it never blocks or places a trade.
   */
  async recordTradeOutcome(input: {
    symbol: string;
    side: Side;
    pnl: number;
    entryIso?: string;
    setup?: string | null;
    score?: number | null;
    rewardRisk?: number | null;
  }): Promise<void> {
    const rec = this.latestExecutedFor(input.symbol, input.side);
    const entryIso = input.entryIso ?? rec?.decidedAt ?? rec?.createdAt;
    const record = await this.memory.add({
      symbol: input.symbol,
      side: input.side,
      setup: input.setup ?? rec?.setupName ?? null,
      score: input.score ?? rec?.avrrioScore ?? null,
      rewardRisk: input.rewardRisk ?? rec?.rewardRiskRatio ?? null,
      entryHour: entryIso
        ? hourInZone(entryIso, this.config.accountTimezone)
        : null,
      pnl: input.pnl,
    });
    await this.audit.log("memory.record", "system", {
      symbol: record.symbol,
      setup: record.setup,
      side: record.side,
      result: record.result,
    });
  }

  /** Most recent executed/decided recommendation for a symbol+side, if any. */
  private latestExecutedFor(
    symbol: string,
    side: Side,
  ): Recommendation | undefined {
    const sym = symbol.toUpperCase();
    return [...this.recommendations.list()]
      .reverse()
      .find((r) => r.symbol.toUpperCase() === sym && r.side === side);
  }

  /**
   * Assess a recommendation (by ref) against Avrrio Memory — the "this resembles
   * a pattern you've struggled with" check. Advisory only.
   */
  assessMemory(ref: string): MemoryAssessment & { ref?: string } {
    const rec =
      this.recommendations.findByRef(ref) ?? this.recommendations.get(ref);
    if (!rec) {
      return this.memory.assess({ setup: null, side: null });
    }
    const assessment = this.memory.assess({
      setup: rec.setupName,
      side: rec.side,
      score: rec.avrrioScore,
      entryHour: hourInZone(rec.createdAt, this.config.accountTimezone),
    });
    return { ...assessment, ref: rec.ref };
  }

  /** Telegram/console-friendly Avrrio Memory summary. */
  memorySummaryText(): string {
    const o = this.memory.overall();
    if (o.trades === 0) {
      return "🧠 AVRRIO MEMORY\nNo closed trades recorded yet. As trades close, Avrrio learns your win rates by setup, side, and time of day.";
    }
    const lines = [
      "🧠 AVRRIO MEMORY",
      `Overall: ${o.trades} trades · ${o.winRate != null ? Math.round(o.winRate * 100) + "% win" : "n/a"} · net ${o.netPnl >= 0 ? "+" : ""}$${o.netPnl}`,
    ];
    const setups = this.memory.bySetup().filter((s) => s.trades > 0);
    if (setups.length) {
      lines.push("By setup:");
      for (const s of setups.slice(0, 6)) {
        lines.push(
          `• ${s.key}: ${s.winRate != null ? Math.round(s.winRate * 100) + "%" : "n/a"} (n=${s.wins + s.losses})`,
        );
      }
    }
    const insights = this.memory.insights();
    if (insights.length) {
      lines.push("", "Insights:");
      lines.push(...insights.map((i) => `• ${i}`));
    }
    return lines.join("\n");
  }

  /** Quick one-off evaluation without storing a recommendation (Phase 1 CLI). */
  async evaluate(idea: TradeIdea) {
    const account = await this.getAccount();
    const snapshot = await this.snapshot(idea.symbol);
    const assessment = this.risk.assess(idea, account);
    const analysis = await this.claude.analyze(snapshot, account);
    return { assessment, analysis, account };
  }
}

const TELEGRAM_HELP = [
  "🤖 Avrrio Trade AI — commands",
  "/scan (or /scan now) — run a scan now; alerts if a setup qualifies, else explains why",
  "/rank — numbered ranked list of every symbol in the universe, best to worst",
  "/why — why nothing qualified in the latest scan",
  '/why <SYMBOL> — full breakdown for one symbol (e.g. "/why MNQ"), even if it wasn\'t a near-miss',
  "/status — mode, account, P&L, positions, kill switch, scheduler, AI",
  "/diag — full pipeline diagnostics (scheduler, Telegram, AI, TopstepX)",
  "/last_signal — the most recent recommendation + last scan summary",
  "/risk — risk limits and current usage",
  "/settings — current mode, scanner cadence, thresholds, timezone",
  '/ask <question> (or just type) — ask the AI; advisory only, cannot trade. Mention a symbol (e.g. "what about NQ?") or "my position" and the answer is grounded in that live data.',
  "/discuss <T-ref> <question> — per-trade chat (e.g. why not buy now?)",
  "/whatif <T-ref> <scenario> — recompute R:R (e.g. move stop to 20010, one contract)",
  "/debate <T-ref|symbol> — Bull case vs Bear case + final verdict",
  "/coach <T-ref> — post-trade review vs your discipline rules (auto-sent after each trade)",
  "/memory [T-ref] — your win rates by setup/side/time, or check one trade vs history",
  "/approve <id> · /reject <id> — act on a pending trade (full risk checks)",
  "/pause · /resume — pause/resume the scanner",
  "/stop — Emergency Stop · /resume confirm — clear it",
].join("\n");

/** Hour (0-23) of an ISO timestamp in the given IANA timezone (server local if empty). */
export function hourInZone(iso: string, timezone: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (!timezone) return d.getHours();
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }).format(d);
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? h % 24 : d.getHours();
  } catch {
    return d.getHours();
  }
}

/** Current hour (0-23) in the given IANA timezone; falls back to server local. */
export function localHour(timezone: string): number {
  if (!timezone) return new Date().getHours();
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }).format(new Date());
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? h % 24 : new Date().getHours();
  } catch {
    return new Date().getHours();
  }
}

/** Time-of-day report title from a local hour (0-23). */
export function reportTitle(hour: number): string {
  if (hour >= 4 && hour < 12) return "🌅 AVRRIO MORNING REPORT";
  if (hour >= 12 && hour < 17) return "🌤️ AVRRIO MIDDAY REPORT";
  if (hour >= 17 && hour < 21) return "🌆 AVRRIO EVENING REPORT";
  return "🌙 AVRRIO NIGHT REPORT";
}

export type { Recommendation, Side, TopstepStatus };
