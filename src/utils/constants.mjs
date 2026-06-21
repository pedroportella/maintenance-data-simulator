export const SYNTHETIC_SOURCE_SYSTEM = "synthetic-source";

export const MILLISECONDS_PER_SECOND = 1000;
export const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND;

export const DEFAULT_SCENARIO_ID = "baseline-week";
export const DEFAULT_SCENARIO_REPEAT = 1;
export const MAX_SCENARIO_REPEAT = 1000;

export const DEFAULT_HTTP_BATCH_SIZE = 100;
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const DEFAULT_READINESS_TIMEOUT_MS = 30_000;

export const DEFAULT_FEED_BATCH_SIZE = DEFAULT_HTTP_BATCH_SIZE;
export const DEFAULT_FEED_MAX_RETRIES = 2;
export const DEFAULT_FEED_RETRY_DELAY_MS = 250;
export const DEFAULT_FEED_TIMEOUT_MS = DEFAULT_HTTP_TIMEOUT_MS;
export const RETRYABLE_HTTP_STATUS_CODES = Object.freeze([408, 429, 500, 502, 503, 504]);

export const DEFAULT_API_SMOKE_REQUESTED_BY = "simulator-api-smoke";
export const API_SMOKE_DECISION_REASON_CODE = "simulator-api-smoke";

export const DEFAULT_EVENTBRIDGE_SOURCE = "maintenance-data-simulator";
export const DEFAULT_EVENTBRIDGE_DETAIL_TYPE = "MaintenanceEvent";
export const EVENTBRIDGE_MAX_ENTRIES_PER_REQUEST = 10;

export const AWS_REGION_MAX_LENGTH = 80;
export const AWS_PROFILE_MAX_LENGTH = 160;
export const EVENT_BUS_NAME_MAX_LENGTH = 256;
