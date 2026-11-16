import {failure} from './errors.js';
export const topicPattern=/^[a-z][a-z0-9_-]*#[a-z0-9][a-z0-9_-]*$/;
type Tree={op:'topic';name:string}|{op:'not';value:Tree}|{op:'and'|'or';left:Tree;right:Tree};
export function parseTopicExpression(value=''):Tree|null {
  const fail=(message:string):never=>failure('MEMORY_TOPICS_INVALID',message);
  if(typeof value!=='string'||value.length>1024)fail('Topic 条件最多1024字符。');
  const tokens:(string|{topic:string})[]=[];let offset=0;
  while(offset<value.length){
    if(/\s/.test(value[offset])){offset++;continue;}
    const symbol=value[offset];
    if('&|!()'.includes(symbol)){tokens.push(symbol);offset++;if(value[offset]===symbol&&'&|'.includes(symbol))offset++;}
    else{const source=value.slice(offset),topic=source.match(/^[a-z][a-z0-9_-]*#[a-z0-9][a-z0-9_-]*/);
      if(topic){tokens.push({topic:topic[0]});offset+=topic[0].length;}
      else{const word=source.match(/^(AND|OR|NOT)\b/i);if(!word)fail(`Topic 条件第${offset+1}字符无效。`);
        tokens.push(({AND:'&',OR:'|',NOT:'!'} as Record<string,string>)[word![0].toUpperCase()]);offset+=word![0].length;}}
    if(tokens.length>64)fail('Topic 条件最多64个标签或操作符。');
  }
  if(!tokens.length)return null;
  let position=0;
  const unary=(depth:number):Tree=>{const current=tokens[position++];
    if(current==='!')return {op:'not',value:unary(depth)};
    if(current==='('){if(depth>=8)fail('括号最多嵌套8层。');const node=disjunction(depth+1);if(tokens[position++]!==')')fail('Topic 条件缺少右括号。');return node;}
    if(typeof current==='object'&&current?.topic)return {op:'topic',name:current.topic};
    return fail('Topic 条件缺少标签。');};
  const conjunction=(depth:number):Tree=>{let node=unary(depth);while(tokens[position]==='&'){position++;node={op:'and',left:node,right:unary(depth)};}return node;};
  const disjunction=(depth:number):Tree=>{let node=conjunction(depth);while(tokens[position]==='|'){position++;node={op:'or',left:node,right:conjunction(depth)};}return node;};
  const tree=disjunction(0);if(position!==tokens.length)fail('Topic 条件中缺少操作符或存在多余括号。');return tree;
}
export function compileTopicExpression(expression='',alias='m'){
  if(!/^[a-z][a-z0-9_]*$/.test(alias))throw Error('Invalid internal SQL alias');
  const tree=parseTopicExpression(expression),params:string[]=[];
  const compile=(node:Tree|null):string=>{if(!node)return '1';if(node.op==='topic'){params.push(node.name);return `EXISTS (SELECT 1 FROM json_each(${alias}.data, '$.topics') AS topic_match WHERE topic_match.type='text' AND topic_match.value=?)`;}
    if(node.op==='not')return `(NOT ${compile(node.value)})`;return `(${compile(node.left)} ${node.op==='and'?'AND':'OR'} ${compile(node.right)})`;};
  return {sql:compile(tree),params,tree};
}
export function matchesTopicExpression(expression:string|Tree|null,topics:string[]){
  const tree=typeof expression==='string'?parseTopicExpression(expression):expression,available=new Set(topics);
  const match=(node:Tree|null):boolean=>!node?true:node.op==='topic'?available.has(node.name):node.op==='not'?!match(node.value):node.op==='and'?match(node.left)&&match(node.right):match(node.left)||match(node.right);
  return match(tree);
}
export const validTopicName=(value:unknown):value is string=>typeof value==='string'&&topicPattern.test(value);
