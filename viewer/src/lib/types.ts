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

export type InitMessage = {
  type: 'init';
  world: WorldPayload;
  clock: ClockPayload;
};

// Each row: [x*1000, y*1000, activity_code]
export type TickMessage = {
  type: 'tick';
  sim_minute: number;
  day_of_year: number;
  day_of_week: number;
  positions: number[][];
};

export type ServerMessage = InitMessage | TickMessage;

export type ControlMessage =
  | { type: 'set_speed'; value: number }
  | { type: 'set_paused'; value: boolean }
  | { type: 'jump_to_minute'; value: number };

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
