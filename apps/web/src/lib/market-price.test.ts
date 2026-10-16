import {describe,it,expect} from 'vitest';
import {marketPriceMinor,marketPriceText} from './market-price.js';
describe('exact price conversion',()=>{
 it.each([['10.01','MXN',1001],['17','JPY',17],['1.234','KWD',1234]] as const)('converts %s %s without float rounding',(value,currency,minor)=>{
  expect(marketPriceMinor(value,currency)).toBe(minor);expect(marketPriceText(minor,currency)).toBe(value);
 });
 it.each(['0.001','1e3','-1','10,20','01','9007199254740991.01'])('rejects malformed or excessive MXN price %s',price=>{
  expect(()=>marketPriceMinor(price,'MXN')).toThrow();
 });
});
