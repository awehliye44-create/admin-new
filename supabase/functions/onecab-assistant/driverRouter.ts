/**
 * Deterministic Driver Assistant router.
 * Domains are data tables. Matching is phrase inclusion, not a policy switch.
 */

import { normaliseQuestion, type Topic } from "./knowledge.ts";
import {
  DRIVER_PRIMARY_TOPICS,
  DRIVER_SUBTOPICS,
  driverFollowUps,
  driverSubtopic,
} from "./driverCatalog.ts";
import type { DriverKnowledgeHit } from "./driverDomainTypes.ts";
import {
  UNKNOWN_DRIVER_CONTEXT,
  type DriverReadContext,
} from "./driverReadContext.ts";

export function foldDriverQuestion(question: string): string {
  const withoutApostrophes = question.replace(/['’]/g, "");
  return normaliseQuestion(withoutApostrophes)
    .replace(/\bdestintion\b/g, "destination")
    .replace(/\bpost code\b/g, "postcode")
    .replace(/\bquied\b/g, "queued")
    .replace(/\bqueud\b/g, "queued")
    .replace(/\bcant\b/g, "cannot")
    .replace(/\bisnt\b/g, "is not")
    .replace(/\bhasnt\b/g, "has not")
    .replace(/\bdidnt\b/g, "did not");
}

function visibleWalletIds(ctx: DriverReadContext): Set<string> | null {
  if (ctx.financialModel === "PLATFORM_COLLECTED") {
    return new Set([
      "wallet_overview",
      "wallet_pending",
      "wallet_withdraw",
      "wallet_payout",
      "wallet_tips",
      "payout_account",
    ]);
  }
  if (ctx.financialModel === "DRIVER_COLLECTED_COMMISSION_WALLET") {
    return new Set(["wallet_overview", "wallet_commission"]);
  }
  return new Set(["wallet_overview"]);
}

function menuIds(primaryId: string, ctx: DriverReadContext): string[] {
  const primary = DRIVER_PRIMARY_TOPICS.find((topic) => topic.id === primaryId);
  if (!primary) return [];
  const walletIds = primaryId === "wallet_earnings" ? visibleWalletIds(ctx) : null;
  return primary.subtopicIds.filter((id) => !walletIds || walletIds.has(id));
}

function hit(id: string, answer: string, related: string[]): DriverKnowledgeHit {
  return { id, answer, followUps: driverFollowUps(related) };
}

export function matchDriverKnowledge(
  question: string,
  quickAction?: string | null,
  context?: DriverReadContext | null,
): DriverKnowledgeHit | null {
  const ctx = context ?? UNKNOWN_DRIVER_CONTEXT;
  const action = typeof quickAction === "string" ? quickAction.trim() : "";

  if (action) {
    const primary = DRIVER_PRIMARY_TOPICS.find((topic) => topic.id === action);
    if (primary) {
      return hit(primary.id, primary.intro, menuIds(primary.id, ctx));
    }
    const topic = driverSubtopic(action);
    if (topic) return hit(topic.id, topic.reply(ctx), topic.related);
  }

  const folded = foldDriverQuestion(question);
  if (!folded) return null;

  let best: { topic: (typeof DRIVER_SUBTOPICS)[number]; score: number } | null = null;
  for (const topic of DRIVER_SUBTOPICS) {
    for (const phrase of topic.phrases) {
      const key = foldDriverQuestion(phrase);
      if (!key) continue;
      if (folded === key || folded.includes(key)) {
        const score = key.length;
        if (!best || score > best.score) best = { topic, score };
      }
    }
  }
  if (!best) return null;
  return hit(best.topic.id, best.topic.reply(ctx), best.topic.related);
}

export function driverTopicsForPrompt(ctx: DriverReadContext = UNKNOWN_DRIVER_CONTEXT): Topic[] {
  const walletIds = visibleWalletIds(ctx);
  return DRIVER_SUBTOPICS.filter((topic) => {
    if (
      topic.domain === "wallet" ||
      topic.domain === "earnings" ||
      topic.domain === "payouts" ||
      topic.domain === "commission_wallet" ||
      topic.domain === "tips"
    ) {
      return walletIds.has(topic.id);
    }
    return true;
  }).map((topic) => ({
    id: topic.id,
    title: topic.label,
    keywords: topic.phrases,
    body: topic.reply(ctx),
  }));
}

export function selectDriverTopicsFromCatalog(
  question: string,
  limit = 3,
  ctx: DriverReadContext = UNKNOWN_DRIVER_CONTEXT,
): Topic[] {
  const folded = foldDriverQuestion(question);
  const pool = driverTopicsForPrompt(ctx);
  const scored = pool
    .map((topic) => {
      let score = 0;
      for (const keyword of topic.keywords) {
        const key = foldDriverQuestion(keyword);
        if (key && folded.includes(key)) score += key.length;
      }
      return { topic, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) {
    const support = pool.find((topic) => topic.id === "support_contact");
    return support ? [support] : pool.slice(0, 1);
  }
  return scored.slice(0, limit).map((row) => row.topic);
}
