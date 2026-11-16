import { createHostedJobStore } from './store.js';
import { describeHostedJobStoreContract } from '../test-support/store-contract.js';

describeHostedJobStoreContract('memory', (options) => createHostedJobStore(options));
