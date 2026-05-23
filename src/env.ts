import 'dotenv/config';
import { z } from 'zod';

// Treat empty strings as "missing" for optional fields, so an unfilled
// MDBLIST_API_KEY= line in .env doesn't fail validation.
const emptyAsUndefined = (val: unknown) => (val === '' ? undefined : val);
const optionalString = z.preprocess(emptyAsUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(emptyAsUndefined, z.string().url().optional());

const schema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  OVERSEERR_URL: z.string().url('OVERSEERR_URL must be a valid URL'),
  OVERSEERR_API_KEY: z.string().min(1, 'OVERSEERR_API_KEY is required'),

  PLEX_URL: optionalUrl,
  PLEX_TOKEN: optionalString,
  MDBLIST_API_KEY: optionalString,

  RADARR_URL: optionalUrl,
  RADARR_API_KEY: optionalString,
  SONARR_URL: optionalUrl,
  SONARR_API_KEY: optionalString,
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Environment configuration error:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('\nSee .env.example for the full list. Fill in .env and try again.');
  process.exit(1);
}

const data = parsed.data;

export const env = {
  ...data,
  OVERSEERR_URL: data.OVERSEERR_URL.replace(/\/$/, ''),
  PLEX_URL: data.PLEX_URL?.replace(/\/$/, ''),
  RADARR_URL: data.RADARR_URL?.replace(/\/$/, ''),
  SONARR_URL: data.SONARR_URL?.replace(/\/$/, ''),
};

export type Env = typeof env;
