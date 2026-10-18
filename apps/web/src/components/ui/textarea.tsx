import * as React from 'react';
import {cn} from '../../lib/utils';
export function Textarea({className,...props}:React.ComponentProps<'textarea'>){
 return <textarea className={cn('textarea',className)} {...props}/>;
}
