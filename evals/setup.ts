// Eval-specific setup. Load .env so ANTHROPIC_API_KEY is available, then
// FORCIBLY override every backend URL with a non-routable test hostname so
// the fetch interceptor in _runner.ts catches all tool traffic. Without this
// override, a real .env (Plex/Overseerr/Radarr/Sonarr URLs) would leak
// through and the eval would mutate live services.
import 'dotenv/config';

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    'ANTHROPIC_API_KEY is required to run evals. Set it in .env or your shell.'
  );
}

// Override AFTER dotenv has loaded. These hosts are the ones BACKEND_HOSTS in
// evals/_runner.ts matches on — keep them in sync.
process.env.OVERSEERR_URL = 'http://overseerr.test';
process.env.OVERSEERR_API_KEY = 'eval-test-overseerr';
process.env.PLEX_URL = 'http://plex.test';
process.env.PLEX_TOKEN = 'eval-test-plex';
process.env.RADARR_URL = 'http://radarr.test';
process.env.RADARR_API_KEY = 'eval-test-radarr';
process.env.SONARR_URL = 'http://sonarr.test';
process.env.SONARR_API_KEY = 'eval-test-sonarr';
process.env.MDBLIST_API_KEY = 'eval-test-mdblist';
