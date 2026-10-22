// src/constants.ts — dependency-free constants for light importers (the CLI's --help path); no imports (#3251).

export const STATE_ROOT_ENV = 'FACTORY_STATE_ROOT';

/** Prefix of factory branches (`ship-it/<n>-…`) created before the default became `factory` (#1714). Still recognized, never created. */
export const LEGACY_BRANCH_PREFIX = 'ship-it';

export const DEFAULT_GARDEN_SINCE = '14d';
export const DEFAULT_GARDEN_MAX_CLUSTERS = 10;

/** Default TCP port for the foreground factoryd listener. */
export const DEFAULT_FACTORYD_PORT = 8787;
