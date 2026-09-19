/**
 * Kept in source rather than read from package.json at runtime: the file is
 * not shipped at a predictable depth from dist/, and a version is something
 * the code should know about itself. A unit test pins it to package.json.
 */
export const APP_NAME = 'pecmailer';
export const APP_VERSION = '0.5.1';
