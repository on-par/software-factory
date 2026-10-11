// CHECK inherits its parent daemon's immutable run snapshot. Tests own their
// configuration fixtures; clear the inherited transport before importing suites.
delete process.env.FACTORY_RUN_CONFIG_JSON;
// A lane running this repo's tests with a state root must not redirect suites expecting <tmp>/.factory.
delete process.env.FACTORY_STATE_ROOT;
