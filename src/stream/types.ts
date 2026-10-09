/**
 * Badge type in a Social Stream message.
 */
export interface SocialStreamBadge {
  type?: string;
  text?: string;
  url?: string;
  [key: string]: unknown;
}

/**
 * Complete Social Stream payload structure (Social Stream Ninja)
 * based on documentation and webhook log schemas.
 */
export interface SocialStreamPayload {
  /** Display name of the message sender */
  chatname?: string;
  /** Alternative fallback username */
  username?: string;
  /** Chat message content */
  chatmessage?: string;
  /** User avatar image URL or DataBlob (< ~55KB) */
  chatimg?: string;
  /** Pre-qualified platform source name (e.g., "youtube", "twitch") */
  type?: string;
  /** Alternative fallback platform */
  platform?: string;
  /** Alternative fallback platform source */
  source?: string;
  /** Alternative image icon URL for the source platform */
  sourceImg?: string;
  /** Channel name or host username for the channel */
  sourceName?: string;
  /** Whether the chat message is plain text only (no rich/HTML elements) */
  textonly?: boolean;
  /** Donation amount along with unit (e.g., "3 roses", "$50 USD") */
  hasDonation?: string;
  /** Array containing user badge URLs or objects */
  chatbadges?: (SocialStreamBadge | string)[];
  /** Single image or mp4/webm video supporting content URL */
  contentimg?: string;
  /** Description or event type of membership */
  membership?: string;
  /** Alternative event title (e.g., CHEERS / DONATION) */
  title?: string;
  /** Additional details for membership event (e.g., month duration) */
  subtitle?: string;
  /** Whether the user is a chat moderator */
  mod?: boolean;
  /** Alias indicating whether the user is a moderator */
  moderator?: boolean;
  /** Whether the message should be treated as an event and its event type */
  event?: string | boolean;
  /** Whether the user is an admin or privileged user */
  admin?: boolean;
  /** Whether the user is a bot or host */
  bot?: boolean;
  /** Whether the message is a certified question */
  question?: boolean;
  /** Unique user ID or source platform username */
  userid?: string;
  /** AI sentiment score of the message (1.0 = positive/happy, 0.0 = negative) */
  karma?: number;
  /** Internal message ID */
  id?: number;
  /** Internal transaction ID */
  tid?: number;
  /** Timestamp when message was created (milliseconds) */
  timestamp?: number;
  /** Bad words or profanity detection flag */
  containsBadWords?: boolean;
  /** URL to the platform logo */
  logo?: string;
  /** Whether this is a private or direct message */
  private?: boolean;
  /** Custom display name color */
  nameColor?: string;
  /** Custom text color for featured messages */
  textColor?: string;
  /** Custom background color for featured messages */
  backgroundColor?: string;
  /** Active video stream ID */
  videoid?: string;
  /** Additional metadata (e.g., platform messageId) */
  meta?: {
    messageId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Parsed Social Stream message result.
 */
export interface ParsedSocialStreamMessage {
  username: string;
  cleanMessage: string;
  rawMessage: string;
  platform: string;
  isCommand: boolean;
  commandType?: "friend" | "creative" | "allow";
  commandArg?: string;
}
