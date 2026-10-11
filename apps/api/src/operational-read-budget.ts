import {pool,type QueryExecutor} from '../../../packages/db/src/index.js';
import {withReadBudget} from '../../../packages/db/src/read-budget.js';
import {fail} from './context.js';

/** An unavailable diagnostic is an error, never healthy state or zero capacity. */
export async function withOperationalReadBudget<T>(read:(c:QueryExecutor)=>Promise<T>,milliseconds=4000):Promise<T>{
 try{return await withReadBudget(pool,milliseconds,read);}
 catch(error){
  const failure=error as {code?:string;message?:string};
  if(['57014','55P03'].includes(failure.code??'')||['READ_BUDGET_EXCEEDED','Query read timeout'].includes(failure.message??'')){
   throw fail(503,'OPERATIONAL_READ_TIMEOUT');
  }
  throw error;
 }
}
