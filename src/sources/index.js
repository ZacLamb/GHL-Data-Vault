import { contactFields, opportunityFields } from './customFields.js';
import { conversations } from './conversations.js';
import { forms, surveys } from './submissions.js';
import { media } from './media.js';
import { documents } from './documents.js';
import { usage } from './usage.js';
import { fileDates } from './fileDates.js';
import { notes } from './notes.js';

export const SOURCES = {
  contact_fields: contactFields,
  opportunity_fields: opportunityFields,
  conversations,
  forms,
  surveys,
  media,
  documents,
  usage,
  file_dates: fileDates,
  notes,
};
// Sources that only run when asked for by name (never in Back up / the monthly backup).
export const ON_DEMAND_SOURCES = ['notes'];
export const ALL_SOURCES = Object.keys(SOURCES).filter(s => !ON_DEMAND_SOURCES.includes(s));
