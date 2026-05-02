// Wire-format types matching what the Python backend emits.

export type GridDict = {
  size: number;
  cell_metres: number;
  latitude: number;
  zoning: number[][]; // [size][size] of Zoning enum int
};

export type EstablishmentDict = {
  id: string;
  kind: string;
  cell: [number, number];
  hours: [number, number];
  name: string;
  capacity: number;
};

export type AgentDict = {
  id: string;
  age: number;
  home_cell: [number, number];
  work_cell: [number, number] | null;
  employer_id: string | null;
  occupation: string;
  mode: string;
};

export type WorldPayload = {
  grid: GridDict;
  establishments: EstablishmentDict[];
  agents: AgentDict[];
};

export type ClockPayload = {
  sim_minute: number;
  day_of_year: number;
  day_of_week: number;
  speed_multiplier: number;
  paused: boolean;
};

// ---------------------------------------------------------------------------
// Product / dialogue / summary wire types (mirror the Python backend's JSON)
// ---------------------------------------------------------------------------

export type TargetFilter = {
  age_bands: string[];
  income_bands: string[];
  occupation_regex: string | null;
};

export type ProductBriefDict = {
  name: string;
  category: string;
  price: number;
  short_description: string;
  detailed_description: string;
  target_audience: string;
  target: TargetFilter;
  key_features: string[];
  positioning: string;
  currency: string;
};

export type LiveStats = {
  n_dialogues: number;
  n_purchases: number;
  n_dialogue_errors?: number;
  n_transport_errors?: number;
  n_llm_errors?: number;
  n_product_dialogues: number;
  n_units_sold: number;
  product_revenue: number;
  arm_random: { count: number; purchases: number };
  arm_targeted: { count: number; purchases: number };
};

export type EnsAgentLookup = {
  agent_id: string;
  ens_name: string | null;
  ens_status: string;
  wallet_address: string | null;
  axl_key: string | null;
  demographics: {
    age: number;
    gender: string;
    education: string;
    income_band: string;
    occupation: string;
    household_role: string;
  };
  home_cell: [number, number];
  work_cell: [number, number] | null;
  card_text: string;
  prefs: Record<string, unknown>;
  needs: Record<string, unknown>;
  establishment: {
    id: string;
    kind: string;
    cell: [number, number];
    name: string;
  } | null;
};

export type DialogueOutcome = {
  purchased?: boolean;
  units?: number;
  price_paid?: number | null;
  decisive_factor?: string;
  intrinsic_motivator?: string;
  seller_winning_phrase?: string | null;
  objections_raised?: string[];
  price_sensitivity?: string;
  target_fit?: string;
  regret_signal?: number;
  followup_intent?: string | null;
};

export type DialogueCard = {
  dialogue_id: string;
  buyer_id: string;
  buyer_age?: number;
  buyer_occupation?: string;
  establishment_id: string;
  establishment_kind: string;
  product_id: string | null;
  dialogue_kind: 'product' | 'generic';
  arm: 'random' | 'targeted';
  targeted: boolean;
  sim_minute: number;
  status: 'live' | 'ended';
  end_reason?: string;
  outcome?: DialogueOutcome | null;
  purchased?: boolean;
  // Streaming-only field — populated on the client as turns arrive.
  turns?: { speaker: 'buyer' | 'seller'; text: string }[];
};

export type SegmentDict = {
  label: string;
  count: number;
  purchases: number;
  conversion: number;
};

export type DaySummaryDict = {
  day: number;
  n_dialogues: number;
  n_purchases: number;
  conversion: number;
  avg_price_paid: number | null;
  total_spend: number;
  fallback_extractions: number;
  by_kind: Record<string, SegmentDict>;
  by_income_band: Record<string, SegmentDict>;
  top_decisive_factors: [string, number][];
  top_establishments: [string, number][];
  has_product: boolean;
  product_name: string | null;
  n_product_dialogues: number;
  n_units_sold: number;
  product_revenue: number;
  avg_product_price: number | null;
  product_conversion: number;
  top_intrinsic_motivators: [string, number][];
  top_winning_phrases: [string, number][];
  top_objections: [string, number][];
  by_age_band: Record<string, SegmentDict>;
  arm_random: SegmentDict;
  arm_targeted: SegmentDict;
  relevant_personas: {
    buyer_id: string;
    age: number | null;
    gender: string | null;
    occupation: string | null;
    income_band: string | null;
    purchased: boolean;
    motivator: string;
    targeted: boolean;
  }[];
};

// ---------------------------------------------------------------------------
// Server -> client messages
// ---------------------------------------------------------------------------

export type InitMessage = {
  type: 'init';
  world: WorldPayload;
  clock: ClockPayload;
  product: ProductBriefDict | null;
  stats: LiveStats;
  recent_dialogues: DialogueCard[];
  last_day_summary: DaySummaryDict | null;
};

// Each row: [x*1000, y*1000, activity_code]
export type TickMessage = {
  type: 'tick';
  sim_minute: number;
  day_of_year: number;
  day_of_week: number;
  positions: number[][];
  stats: LiveStats;
};

export type DialogueStartedMessage = {
  type: 'dialogue_started';
  dialogue_id: string;
  buyer_id: string;
  buyer_age?: number;
  buyer_gender?: string;
  buyer_occupation?: string;
  buyer_income_band?: string;
  seller_id: string;
  seller_occupation?: string;
  establishment_id: string;
  establishment_kind: string;
  product_id: string | null;
  dialogue_kind: 'product' | 'generic';
  arm: 'random' | 'targeted';
  targeted: boolean;
  sim_minute: number;
  day_of_year: number;
};

export type DialogueTurnMessage = {
  type: 'dialogue_turn';
  dialogue_id: string;
  speaker: 'buyer' | 'seller';
  text: string;
};

export type DialogueEndedMessage = {
  type: 'dialogue_ended';
  dialogue_id: string;
  end_reason: string;
  duration_s: number;
  outcome: DialogueOutcome;
  dialogue_kind: 'product' | 'generic';
  arm: 'random' | 'targeted';
  targeted: boolean;
  product_id: string | null;
};

export type DaySummaryMessage = {
  type: 'day_summary';
  day: number;
  summary: DaySummaryDict;
};

export type ProductUpdatedMessage = {
  type: 'product_updated';
  product: ProductBriefDict | null;
};

export type ServerMessage =
  | InitMessage
  | TickMessage
  | DialogueStartedMessage
  | DialogueTurnMessage
  | DialogueEndedMessage
  | DaySummaryMessage
  | ProductUpdatedMessage;

export type ControlMessage =
  | { type: 'set_speed'; value: number }
  | { type: 'set_paused'; value: boolean }
  | { type: 'jump_to_minute'; value: number }
  | { type: 'set_dialogue_workers'; value: number };

// Zoning enum values (must match Python `Zoning`)
export const ZONING = {
  PARKS: 0,
  RESIDENTIAL: 1,
  MIXED: 2,
  COMMERCIAL: 3,
  INDUSTRIAL: 4,
  CIVIC: 5,
} as const;

// Activity codes (must match `ACTIVITY_CODES` in schedule.py)
export const ACTIVITY = {
  SLEEP: 0,
  COMMUTE: 1,
  WORK: 2,
  EAT: 3,
  SHOP: 4,
  LEISURE: 5,
  SCHOOL: 6,
} as const;

export const ACTIVITY_NAMES: Record<number, string> = {
  0: 'sleep',
  1: 'commute',
  2: 'work',
  3: 'eat',
  4: 'shop',
  5: 'leisure',
  6: 'school',
};

export type ViewMode = 'agent' | 'heatmap' | 'conversion';
