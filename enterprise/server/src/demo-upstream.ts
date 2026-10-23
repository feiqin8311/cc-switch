import {
  CODING_PLAN_ACCOUNT_NAME,
  type UpstreamAccount,
} from "@ccse/contracts";

/** Local preview fixtures. No credentials or upstream network connections. */
export function demoUpstreamAccounts(): UpstreamAccount[] {
  const names = [
    "EZARC-GPT1",
    "EZARC-GPT2",
    "Fubin-GPT",
    "Kevin-Grok",
    "Libraton-GPT1",
    "Libraton-Gpt2",
    "Oyww-GPT",
    "Yida-GPT",
    "Yplus-GPT",
    "Zjn-GPT",
    "产品部-GPT",
    CODING_PLAN_ACCOUNT_NAME,
  ];
  return names.map((name, index) => ({
    id: 900001 + index,
    subscriptionExpiresAt:
      index === 11 ? "2026-11-19T15:59:00Z" : "2026-10-23T08:00:00Z",
    name,
    email: null,
    platform: index === 3 ? "grok" : index === 11 ? "volcengine" : "openai",
    planType:
      index === 0
        ? "prolite"
        : index === 11
          ? "Pro"
          : index === 3
            ? "SuperGrok"
            : "plus",
    type: "demo",
    status: "active",
    schedulable: false,
    groups: ["本机测试数据"],
    currentConcurrency: 0,
    maxConcurrency: 1,
    windows: [],
  }));
}
