import type { DriverReadContext } from "./driverReadContext.ts";

export type DriverFollowUp = {
  id: string;
  label: string;
};

export type DriverSubtopic = {
  id: string;
  domain: string;
  label: string;
  phrases: string[];
  related: string[];
  reply: (ctx: DriverReadContext) => string;
};

export type DriverPrimaryTopic = {
  id: string;
  intro: string;
  subtopicIds: string[];
};

export type DriverKnowledgeHit = {
  id: string;
  answer: string;
  followUps: DriverFollowUp[];
};
