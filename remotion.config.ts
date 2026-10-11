import {Config} from '@remotion/cli/config';

// Remotion solo lee este archivo de variables: no contiene secretos.
Config.setDotEnvLocation('.env.remotion');
Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(95);
Config.setOverwriteOutput(true);
Config.setPublicDir('public');
