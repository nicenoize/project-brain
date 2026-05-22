/**
 * Cross-project edge detector contract.
 *
 * Each detector is an async generator that streams EdgeCandidate objects.
 * The runner (scripts/edges/index.mjs) iterates DETECTORS in order, sharing
 * `context.facts` between them (so later detectors can consume e.g.
 * `imageRegistry` published by `image-registry.mjs`).
 *
 * @typedef {Object} ProjectDescriptor
 * @property {string} name
 * @property {string} dir         relative to fleet root
 * @property {string[]} kinds     ['node','go','python','helm','kustomize','docker','proto','terraform']
 * @property {boolean} git
 * @property {boolean} hasReadme
 *
 * @typedef {Object} DetectorContext
 * @property {string} ROOT
 * @property {ProjectDescriptor[]} projects
 * @property {Map<string,string>} projectDirs       project.name -> absolute dir
 * @property {Set<string>} dirtyProjects            empty Set = all dirty / full rebuild
 * @property {Map<string,any>} facts                shared between detectors (e.g. imageRegistry)
 * @property {{get,set,has}|null} cache             per-detector cache (null = disabled)
 * @property {{warn,info,debug}} logger
 * @property {AbortSignal} signal
 *
 * @typedef {Object} EdgeCandidate
 * @property {string} from                          producer / caller project name
 * @property {string} to                            consumer / callee project name
 * @property {('k8s-image'|'http-call'|'grpc-call'|'proto-schema'|'openapi-schema'|'env-shared'|'pubsub'|'db-shared'|'package-dep'|'go-replace')} kind
 * @property {string[]} evidence                    'fleet-relative-path:line' lines
 * @property {('high'|'medium'|'low')} confidence
 * @property {string} detector                      name of the detector module that emitted this
 * @property {object} [meta]                        free-form per-detector payload (e.g. topic name)
 *
 * @typedef {(ctx: DetectorContext) => AsyncIterable<EdgeCandidate>} Detector
 */

export {};
