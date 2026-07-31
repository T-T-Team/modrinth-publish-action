const actions = require('@actions/core');
const fs = require('fs');
const path = require('path');

const VERSION_NUMBER_REGEX = /([\d.]+(?:-\w+[.\d]*)?(?:\+[\d.]+)?)$/;
const BASE_API_URL = "https://api.modrinth.com/v2";
const URL_GET_PROJECT_BASE = `${BASE_API_URL}/project`;
const URL_CREATE_VERSION = `${BASE_API_URL}/version`;

const EXCLUDED_FILE_SUFFIXES = [
  "sources", "javadoc", "dev", "all", "shadow"
];

const CHANNEL_RELEASE = "release";
const CHANNEL_BETA = "beta";
const CHANNEL_ALPHA = "alpha";
const RECOGNIZE_CHANNEL_LIST = [
  CHANNEL_ALPHA, CHANNEL_BETA
];
const CHANNEL_TYPES = [
  CHANNEL_RELEASE, ...RECOGNIZE_CHANNEL_LIST
];

const RELATION_REQUIRED = "required";
const RELATION_OPTIONAL = "optional";
const RELATION_EMBEDDED = "embedded";
const RELATION_INCOMPATIBLE = "incompatible";

const ENV_CLIENT_AND_SERVER = "client_and_server";
const ENV_CLIENT_OR_SERVER = "client_or_server";
const ENV_CLIENT_OR_SERVER_PREF_BOTH = "client_or_server_prefers_both";
const ENV_CLIENT = "client_only";
const ENV_CLIENT_SERVER_OPTIONAL = "client_only_server_optional";
const ENV_SERVER = "server_only";
const ENV_SERVER_CLIENT_OPTIONAL = "server_only_client_optional";
const ENV_SINGLEPLAYER = "singleplayer_only";
const ENV_DEDICATED_SERVER = "dedicated_server_only";
const ENV_UNKNOWN = "unknown";
const ENVIRONMENTS = [
  ENV_CLIENT_AND_SERVER, ENV_CLIENT_OR_SERVER, ENV_CLIENT_OR_SERVER_PREF_BOTH, ENV_CLIENT, ENV_CLIENT_SERVER_OPTIONAL,
  ENV_SERVER, ENV_SERVER_CLIENT_OPTIONAL, ENV_SINGLEPLAYER, ENV_DEDICATED_SERVER, ENV_UNKNOWN
];

const LOADER_FORGE = "Forge";
const LOADER_FABRIC = "Fabric";
const LOADER_NEOFORGE = "NeoForge";
const LOADER_QUILT = "Quilt";
const LOADER_RIFT = "Rift";
const MOD_LOADERS = [
  LOADER_FORGE, LOADER_FABRIC, LOADER_NEOFORGE, LOADER_QUILT, LOADER_RIFT
];

const HTTP_METHOD = {
  GET: "GET",
  POST: "POST"
};

const inputs = {
  artifactDirectory: actions.getInput("artifact-directory", {trimWhitespace: true}),
  token: actions.getInput("token", {trimWhitespace: true}),
  projectId: actions.getInput("project-id", {trimWhitespace: true}),
  changelogContent: actions.getInput("changelog-content", {trimWhitespace: true}),
  releaseChannel: actions.getInput("release-channel", {trimWhitespace: true}),
  gameVersion: actions.getInput("game-version", {trimWhitespace: true}),
  modLoader: actions.getInput("mod-loader", {trimWhitespace: true}),
  gameEnvironment: actions.getInput("game-environment", {trimWhitespace: true}),
  featureVersion: actions.getBooleanInput("feature-version", {trimWhitespace: true}),
  dependencies: {
    required: actions.getInput("required-dependencies", {trimWhitespace: true}),
    optional: actions.getInput("optional-dependencies", {trimWhitespace: true}),
    embedded: actions.getInput("embedded-dependencies", {trimWhitespace: true}),
    incompatible: actions.getInput("incompatible-dependencies", {trimWhitespace: true})
  },
  debug: actions.getBooleanInput("debug-mode")
};

const projectIdCache = new Map();

async function main() {
  // Assign default values
  setDefaultValuesAndValidate();

  // Prepare all files for upload
  const uploadArtifact = await resolveUploadArtifact();

  // Upload files
  await upload(uploadArtifact);
}

async function upload(artifact) {
  const payload = new FormData();
  payload.append("file", artifact.file, `${artifact.name}.jar`);

  const data = JSON.stringify({
    name: artifact.name,
    version_number: artifact.version_number,
    changelog: artifact.changelog,
    dependencies: artifact.dependencies,
    game_versions: artifact.game_versions,
    version_type: artifact.version_type,
    loaders: artifact.loaders,
    environment: artifact.environment,
    featured: artifact.featured,
    project_id: artifact.project_id,
    primary_file: artifact.primary_file,
    file_parts: artifact.file_parts
  });
  payload.append("data", new Blob([data], { type: "application/json" }));

  const uploadOptions = {
    body: payload
  }
  let versionId = 0;
  if (inputs.debug) {
    actions.info(`Debug mode is enabled, nothing will be uploaded! Payload content:\n${data}`);
  } else {
    const result = await sendApiRequest(HTTP_METHOD.POST, URL_CREATE_VERSION, uploadOptions);
    versionId = result.id;
    actions.info(`File uploaded successfully. created version ID ${versionId}`);
  }
  actions.setOutput("version-id", versionId);
}

function setDefaultValuesAndValidate() {
  requireInput(inputs.artifactDirectory, "artifact-directory");
  requireInput(inputs.token, "token");
  requireInput(inputs.projectId, "project-id");
  requireInput(inputs.gameVersion, "game-version");
  requireInput(inputs.modLoader, "mod-loader")


  // Game environment
  if (!ENVIRONMENTS.includes(inputs.gameEnvironment)) {
    throw new Error(`Invalid game environment '${inputs.gameEnvironment}', must be one of: ${ENVIRONMENTS}`);
  }

  // Release channel
  if (inputs.releaseChannel && !CHANNEL_TYPES.includes(inputs.releaseChannel)) {
    throw new Error(`Invalid release channel '${inputs.releaseChannel}', must be one of: ${CHANNEL_TYPES}`);
  }

  // Mod loaders
  const loaders = parseInputList(inputs.modLoader);
  for (const loader of loaders) {
    if (!MOD_LOADERS.includes(loader)) {
      throw new Error(`Invalid mod loader '${loader}', must be one of: ${MOD_LOADERS}`);
    }
  }
}

async function resolveUploadArtifact() {
  if (!fs.existsSync(inputs.artifactDirectory)) {
    throw new Error(`Artifact directory does not exist: ${inputs.artifactDirectory}`);
  }

  const allFiles = fs.readdirSync(inputs.artifactDirectory);
  const matchingReleaseFiles = allFiles.filter(filterFile);
  actions.debug(`Loaded ${matchingReleaseFiles.length} matching files`);
  if (actions.isDebug()) {
    matchingReleaseFiles.forEach(file => actions.debug(`File: ${file}`));
  }

  if (matchingReleaseFiles.length !== 1) {
    throw new Error(`Found total ${matchingReleaseFiles.length} artifacts for upload, expected only 1:\n${matchingReleaseFiles}`);
  }

  const resultArtifact = matchingReleaseFiles[0];
  return await processFile(path.join(inputs.artifactDirectory, resultArtifact));
}

function filterFile(file) {
  if (!file.endsWith(".jar")) {
    return false;
  }
  for (const suffix of EXCLUDED_FILE_SUFFIXES) {
    const fullSuffix = `-${suffix}.jar`;
    if (file.endsWith(fullSuffix)) {
      return false;
    }
  }
  return true;
}

async function processFile(artifact) {
  // game version
  const gameVersions = parseInputList(inputs.gameVersion);
  // mod loader
  const loaders = parseInputList(inputs.modLoader, ",", loader => loader.toLowerCase());

  const displayName = path.basename(artifact, ".jar").toLowerCase();
  const versionNumber = resolveVersionNumberFromFilename(displayName);
  const releaseChannel = inputs.releaseChannel || resolveReleaseType(displayName);

  // Dependencies
  const dependencies = [];
  await Promise.all([
    resolveDependencyList(inputs.dependencies.required, RELATION_REQUIRED, dependencies),
    resolveDependencyList(inputs.dependencies.optional, RELATION_OPTIONAL, dependencies),
    resolveDependencyList(inputs.dependencies.embedded, RELATION_EMBEDDED, dependencies),
    resolveDependencyList(inputs.dependencies.incompatible, RELATION_INCOMPATIBLE, dependencies)
  ]);

  // Read the file
  const fileContent = await fs.promises.readFile(artifact);
  const blob = new Blob([fileContent], { type: "application/java-archive" });

  return {
    file: blob,
    // upload metadata
    name: displayName,
    version_number: versionNumber,
    version_type: releaseChannel,
    changelog: inputs.changelogContent,
    dependencies: dependencies,
    game_versions: gameVersions,
    loaders: loaders,
    featured: inputs.featureVersion,
    project_id: inputs.projectId,
    environment: inputs.gameEnvironment,
    primary_file: "file",
    file_parts: [ "file" ]
  }
}

function resolveVersionNumberFromFilename(filename) {
  const match = filename.match(VERSION_NUMBER_REGEX);
  if (!match) {
    throw new Error(`Failed to find version number in the filename`);
  }
  return match[1];
}

function resolveReleaseType(filename) {
  for (const channel of RECOGNIZE_CHANNEL_LIST) {
    if (filename.includes(`-${channel}`)) {
      return channel;
    }
  }
  return CHANNEL_RELEASE;
}

async function resolveDependencyList(inputString, relation, output) {
  if (!inputString) {
    return;
  }

  const projects = parseInputList(inputString);

  const dependencies = await Promise.all(
    projects.map(async (project) => {
      let projectId = projectIdCache.get(project);
      if (!projectId) {
        const projectInfo = await sendApiRequest(HTTP_METHOD.GET, `${URL_GET_PROJECT_BASE}/${project}`, {}, false);
        projectId = projectInfo.id;
        projectIdCache.set(project, projectId);
      }
      return {
        project_id: projectId,
        dependency_type: relation
      };
    })
  );

  output.push(...dependencies);
}

function parseInputList(values, separator = ",", mapper = (v) => v) {
  if (!values) {
    return [];
  }
  const result = values.split(separator);
  return result.map(value => mapper(value.trim())).filter(Boolean);
}

async function sendApiRequest(method, url, options = {}, contentLogging = true) {
  const headers = options?.headers || {};
  const requestOptions = {
    ...options,
    method,
    headers: {
      ...headers,
      Authorization: `Bearer ${inputs.token}`
    }
  };
  if (contentLogging) {
    const body = options?.body || {};
    actions.debug(`Sending request to ${url} with body:\n${JSON.stringify(body, null, 2)}`);
  }
  const response = await fetch(url, requestOptions);
  const body = await response.text();
  if (actions.isDebug() && contentLogging) {
    actions.debug("Response content:");
    actions.debug(body);
  }
  if (!response.ok) {
    throw new Error(`Modrinth API request failed: ${response.status} ${response.statusText}\n${body}`);
  }
  return body ? JSON.parse(body) : {};
}

function requireInput(value, name) {
  if (!value) {
    throw new Error(`Missing required input: ${name}`);
  }
}

main()
  .catch(e => actions.setFailed(e.message));