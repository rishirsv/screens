// Domain limits. Stroke and title limits match the shipped Twombly config (POINTER_HAND_PEN_SPEC §6.4).

export const TITLE_MAX = 120;
export const STROKE_MAX_POINTS = 3000;
export const STROKES_MAX = 2000;
export const STROKE_SIZE_MAX = 2000;
export const ITEMS_MAX = 500;
/** Ids clients make for strokes, threads and comments. Core makes none. */
export const CLIENT_ID = /^[a-z0-9]{8,32}$/;
export const THREADS_MAX = 1000;
export const COMMENTS_PER_THREAD_MAX = 500;
/** Characters, after trimming. */
export const COMMENT_MAX = 5000;
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const ITEM_SIZE_MIN = 1;
export const ITEM_SIZE_MAX = 100_000;
export const FOLDERS_MAX = 500;
/** Starting value, not measured. */
export const MEDIA_MAX = 20_000;
export const MEDIA_DESCRIPTION_MAX = 2000;
export const MEDIA_FIELD_MAX = 80;
export const MEDIA_SOURCE_MAX = 500;
export const MEDIA_TAGS_MAX = 24;
export const MEDIA_TAG_MAX = 40;
