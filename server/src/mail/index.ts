/**
 * Lane C public surface: header block handling, VERP, and the pure
 * forward/reply rewrite engine. Wave 2 (mx/submission wiring) codes its DB
 * adapters against the ctx/callback interfaces exported here.
 */

export {
  type Address,
  formatAddress,
  formatAddressList,
  formatDateHeader,
  HeaderBlock,
  type HeaderField,
  type ParsedMessage,
  parseAddressList,
  parseMessage,
  serializeMessage,
  unfoldValue,
} from "./headers.ts";

export {
  buildVerp,
  type BuildVerpOptions,
  parseVerp,
  type ParseVerpOptions,
  VERP_DEFAULT_PREFIX,
  VERP_MESSAGE_LIFETIME,
  VERP_MIN_SECRET_LENGTH,
  VERP_TIME_START,
  VERP_TYPE_CODES,
  type VerpInfo,
  type VerpType,
} from "./verp.ts";

export {
  applyHeaderWhitelist,
  type ContactRef,
  type ContactSource,
  FORWARD_HEADER_WHITELIST,
  type ForwardActions,
  type ForwardContext,
  type ForwardResult,
  forwardDisplayName,
  headerNameInList,
  rewriteForward,
} from "./rewriteForward.ts";

export {
  OPERATOR_HEADER_WHITELIST,
  type OperatorContext,
  type OperatorResult,
  rewriteOperator,
} from "./rewriteOperator.ts";

export {
  type NonReverseAliasRefusal,
  REPLY_HEADER_WHITELIST,
  type ReplyActions,
  type ReplyContext,
  type ReplyResult,
  type ReverseAliasRef,
  rewriteReply,
} from "./rewriteReply.ts";
