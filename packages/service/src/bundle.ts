// Set only in the published package (release/build.mjs defines __SCREENS_BUNDLE__). Source runs see null.

declare const __SCREENS_BUNDLE__: { readonly name: string; readonly version: string } | undefined;

/** The published package's facts, or null when running from a checkout. */
export const bundle: { readonly name: string; readonly version: string } | null = typeof __SCREENS_BUNDLE__ === "undefined" ? null : __SCREENS_BUNDLE__;
