 const hats=[{id:'cap',label:'Cap'},{id:'beanie',label:'Beanie'},{id:'bowler',label:'Classic bowler hat'}];
 const christmas=[{id:'santa_hat',label:'Santa hat'},{id:'elf_hat',label:'Elf hat'},{id:'reindeer_antlers',label:'Reindeer antlers'}];
 const halloween=[{id:'ghost',label:'Ghost sheet'},{id:'skull',label:'Skull mask'},{id:'pumpkin',label:'Pumpkin mask'},{id:'devil_horns',label:'Devil horns'}];
 const glasses=[
  {id:'matrix_oval',label:'Circle sunglasses',square:false,clear:false,opacity:.95},
  {id:'circle_eyeglasses',label:'Circle eyeglasses',square:false,clear:true,opacity:.4},
  {id:'matrix_square',label:'Square sunglasses',square:true,clear:false,opacity:.95},
  {id:'square_eyeglasses',label:'Square eyeglasses',square:true,clear:true,opacity:.4},
  {id:'matrix_aviator',label:'Aviator',square:false,clear:false,opacity:.95,topBridge:true}
 ];
 export const PixelkinAccessories=Object.freeze({
  version:1,christmas:Object.freeze(christmas.map(Object.freeze)),halloween:Object.freeze(halloween.map(Object.freeze)),hats:Object.freeze(hats.map(Object.freeze)),glasses:Object.freeze(glasses.map(Object.freeze)),
  getHat:id=>hats.find(item=>item.id===id),getGlasses:id=>glasses.find(item=>item.id===id),
  ids:kind=>(kind==='hat'?hats:kind==='halloween'?halloween:kind==='christmas'?christmas:glasses).map(item=>item.id)
 });
