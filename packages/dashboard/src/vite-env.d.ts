/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Comma-separated repo slugs (`owner/name`) to show in the overview even when idle.
   *  Injected build-time config, never a network read — see ADR-0038/ADR-0039 and the
   *  ADR proposed alongside this change. */
  readonly VITE_FACTORY_REPOS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
