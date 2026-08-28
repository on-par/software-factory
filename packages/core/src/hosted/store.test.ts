import { createHostedJobStore } from './store.js';
import { describeHostedJobStoreContract } from './store-contract.js';

describeHostedJobStoreContract('memory', (options) => createHostedJobStore(options));
