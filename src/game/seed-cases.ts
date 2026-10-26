// Hand-written starter cases on the sample data that ships with a local
// Zetaris (TPCDS_DB, the TPC-DS retail benchmark, and NY_TAXI), kept to
// queries a laptop answers in seconds. Column names
// follow the standard TPC-DS and NYC TLC schemas; every case still has to pass
// validateCase against the live data before a player sees it
// (npm run validate:cases). The case designer adds new cases at runtime.

import type { Case } from "./cases.ts";

export const SEED_CASES: Case[] = [
  {
    id: "seed-damaged-goods",
    title: "Damaged goods",
    story: "A returns clerk swears customers keep bringing things back broken. Before you believe her, check how the store records why things come back.",
    question: "List every return reason whose description mentions damage. Show the reason's id and its description.",
    answerSql: "SELECT r_reason_sk, r_reason_desc FROM TPCDS_DB.reason WHERE lower(r_reason_desc) LIKE '%damage%'",
    orderMatters: false,
    skills: ["select", "filter"],
    level: 1,
    databases: ["TPCDS_DB"],
    hints: ["The reasons live in TPCDS_DB.reason.", "LIKE with % matches text anywhere in a value; lower() makes the match ignore case."],
    origin: "seed",
  },
  {
    id: "seed-excuses",
    title: "Excuses, excuses",
    story: "The returns desk hears the same complaints all day, and the worst ones all start the same way. The manager wants every one of them on her desk by morning.",
    question: "List every return reason whose description starts with \"Did not\". Show the reason's id and its description.",
    answerSql: "SELECT r_reason_sk, r_reason_desc FROM TPCDS_DB.reason WHERE r_reason_desc LIKE 'Did not%'",
    orderMatters: false,
    skills: ["select", "filter"],
    level: 1,
    databases: ["TPCDS_DB"],
    hints: ["The reasons are in TPCDS_DB.reason again.", "LIKE with % only at the end matches text that starts a certain way."],
    origin: "seed",
  },
  {
    id: "seed-biggest-floor",
    title: "Room to hide",
    story: "Someone has been storing stolen stock in the back of a store. The chain's biggest store has the most room to hide it.",
    question: "Which store has the largest floor space? Show its store id, name and floor space.",
    answerSql: "SELECT s_store_id, s_store_name, s_floor_space FROM TPCDS_DB.store ORDER BY s_floor_space DESC LIMIT 1",
    orderMatters: true,
    skills: ["select", "sort-limit"],
    level: 1,
    databases: ["TPCDS_DB"],
    hints: ["Stores are in TPCDS_DB.store.", "Sort by floor space from biggest to smallest, then keep only the first row."],
    origin: "seed",
  },
  {
    id: "seed-borough-zones",
    title: "Whose turf",
    story: "A taxi dispatcher swears the city is carved up so you can lose a tail in any borough. Before you pick your turf, find out how the zones are split.",
    question: "How many taxi zones does each borough have? Show each borough and its count.",
    answerSql: "SELECT Borough, COUNT(*) AS zones FROM NY_TAXI.taxi_zones GROUP BY Borough",
    orderMatters: false,
    skills: ["aggregate", "group-by"],
    level: 2,
    databases: ["NY_TAXI"],
    hints: ["NY_TAXI.taxi_zones lists the zones, each with its Borough.", "GROUP BY the borough and COUNT(*) the zones in each."],
    origin: "seed",
  },
  {
    id: "seed-top-return-reason",
    title: "The usual excuse",
    story: "Returns are eating the stores' margin. The regional manager wants the one excuse customers give most often, counted in items, not in visits.",
    question: "Which return reason accounts for the most items returned to stores? Show the reason and the number of items.",
    answerSql:
      "SELECT r.r_reason_desc, SUM(sr.sr_return_quantity) AS items FROM TPCDS_DB.store_returns sr JOIN TPCDS_DB.reason r ON sr.sr_reason_sk = r.r_reason_sk GROUP BY r.r_reason_desc ORDER BY items DESC LIMIT 1",
    orderMatters: true,
    skills: ["join", "aggregate", "group-by", "sort-limit"],
    level: 2,
    databases: ["TPCDS_DB"],
    hints: [
      "Store returns are in TPCDS_DB.store_returns; each has a reason key, sr_reason_sk.",
      "Join it to TPCDS_DB.reason on the reason key, then SUM the returned quantity per reason.",
    ],
    origin: "seed",
  },
  {
    id: "seed-weekend-tickets",
    title: "The weekend shift",
    story: "The night manager claims the weekend crew rang up hardly anything in 2002. The receipts will say otherwise, or not.",
    question: "How many distinct store sales tickets were rung up on weekend days in 2002?",
    answerSql:
      "SELECT COUNT(DISTINCT ss.ss_ticket_number) AS tickets FROM TPCDS_DB.store_sales ss JOIN TPCDS_DB.date_dim d ON ss.ss_sold_date_sk = d.d_date_sk WHERE d.d_year = 2002 AND d.d_weekend = 'Y'",
    orderMatters: false,
    skills: ["join", "date-logic", "aggregate"],
    level: 3,
    databases: ["TPCDS_DB"],
    hints: [
      "Sales store a date key (ss_sold_date_sk); the calendar is TPCDS_DB.date_dim.",
      "date_dim has d_year and d_weekend ('Y' or 'N'). Count DISTINCT ticket numbers, since one ticket has many lines.",
    ],
    origin: "seed",
  },
  {
    id: "seed-crowded-towns",
    title: "Crowded towns",
    story: "Head office thinks some towns have more of our stores than they need. Two shops on the same street, cutting each other's throats.",
    question: "Which cities have two or more stores? Show each city and how many stores it has.",
    answerSql: "SELECT s_city, COUNT(*) AS stores FROM TPCDS_DB.store GROUP BY s_city HAVING COUNT(*) >= 2",
    orderMatters: false,
    skills: ["aggregate", "group-by", "having"],
    level: 2,
    databases: ["TPCDS_DB"],
    hints: [
      "Stores are in TPCDS_DB.store, each with its s_city.",
      "Group the stores by city, count them, and keep the groups with HAVING, not WHERE: WHERE can't see a count.",
    ],
    origin: "seed",
  },

];
