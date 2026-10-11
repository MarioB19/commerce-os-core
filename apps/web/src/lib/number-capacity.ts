type CapacityValue=Record<string,any>;

const count=(value:unknown)=>{
 const parsed=Number(value);
 return Number.isInteger(parsed)&&parsed>=0?parsed:0;
};

export function capacityMinimum(data?:CapacityValue|null){
 const metrics=(data?.metrics??{}) as CapacityValue;
 const slots=[...(Array.isArray(data?.slots)?data.slots:[]),...(Array.isArray(data?.legacy_reservations)?data.legacy_reservations:[])];
 const highestSlot=Math.max(0,...slots.map(item=>count(item?.slot)));
 const explicitInventoryFloor=count(metrics.inventory_floor??data?.inventory_floor);
 const inventoryCount=Array.isArray(data?.slots)?data.slots.length:0;
 const reserved=count(metrics.reserved??data?.reserved??(count(data?.canonical_reserved)+count(data?.legacy_reserved)));
 const provisioned=count(metrics.provisioned_verified??data?.installed);
 return Math.max(1,highestSlot,explicitInventoryFloor,inventoryCount,reserved,provisioned);
}
