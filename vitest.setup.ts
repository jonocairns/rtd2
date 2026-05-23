// Load .env first so real values (especially model API keys for evals)
// survive — then ??= fills in the rest for unit tests where backend creds
// aren't needed.
import 'dotenv/config';

process.env.ANTHROPIC_API_KEY ??= 'test-anthropic-key';
process.env.OPENAI_API_KEY ??= 'test-openai-key';
process.env.OVERSEERR_URL ??= 'http://overseerr.test';
process.env.OVERSEERR_API_KEY ??= 'test-overseerr-key';
process.env.PLEX_URL ??= 'http://plex.test';
process.env.PLEX_TOKEN ??= 'test-plex-token';
process.env.MDBLIST_API_KEY ??= 'test-mdblist-key';
process.env.RADARR_URL ??= 'http://radarr.test';
process.env.RADARR_API_KEY ??= 'test-radarr-key';
process.env.SONARR_URL ??= 'http://sonarr.test';
process.env.SONARR_API_KEY ??= 'test-sonarr-key';
