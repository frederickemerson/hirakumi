-- Which endpoints need the API's key, as the OpenAPI file says (the coworker's parse step, needsKey). Every statement
-- can run again.
--
-- needs_key: true when the endpoint's security (or a declared key parameter) requires the key, false when the file
-- says it is public, null when not known (endpoints parsed before this migration). The key check at save prefers an
-- endpoint that needs the key: a public endpoint answers 200 to any key, so its answer proves nothing.
alter table operations add column if not exists needs_key boolean;
