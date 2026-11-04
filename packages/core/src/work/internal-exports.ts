// Work-source ticket write-back exports re-exported from internal.ts (keeps that file under its max-lines ceiling)
export {
  closesTrailer,
  createLinearTicketWriteback,
  mirrorSlicePlanToTicket,
  postTicketComment,
  ticketKeyOf,
  ticketTrackerOf,
  type LinearTicketClient,
  type TicketTrackerKind,
  type TicketWriteback,
} from './ticket-writeback.js';
export { isTicketKey } from './work-key.js';
