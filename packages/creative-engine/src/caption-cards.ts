import type {TimedWord} from '../../creative-contracts/src/index.js';
export function captionCards(words:TimedWord[],limit:number,minimumWords=1){const cards:Array<{id:string;words:TimedWord[]}>=[];for(const word of words){let card=cards.at(-1);if(!card||card.words[0].chunkId!==word.chunkId||card.words.length===limit){card={id:`${word.chunkId}-${cards.length}`,words:[]};cards.push(card);}card.words.push(word);}
 // Preserve chunk timing; rebalance 4+1 into 3+2 instead of losing or flashing the final word.
 if(minimumWords>1)for(let i=1;i<cards.length;i++){const card=cards[i],prior=cards[i-1];while(card.words.length<minimumWords&&prior.words.length>minimumWords&&prior.words[0].chunkId===card.words[0].chunkId)card.words.unshift(prior.words.pop()!);}
 return cards;
}
