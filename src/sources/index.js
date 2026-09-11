import { contactFields, opportunityFields } from './customFields.js';
import { conversations } from './conversations.js';
import { forms, surveys } from './submissions.js';
import { media } from './media.js';
import { documents } from './documents.js';

export const SOURCES = {
  contact_fields: contactFields,
  opportunity_fields: opportunityFields,
  conversations,
  forms,
  surveys,
  media,
  documents,
};
export const ALL_SOURCES = Object.keys(SOURCES);
