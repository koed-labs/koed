import { EXPRESSIONS } from './expressions.js';
import { PixelkinAccessories } from './accessories.js';

  const SKULL_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"600\" height=\"528\" viewBox=\"490 200 300 264\"><defs><mask id=\"cut\" maskUnits=\"userSpaceOnUse\" x=\"490\" y=\"200\" width=\"300\" height=\"264\"><rect x=\"490\" y=\"200\" width=\"300\" height=\"264\" fill=\"white\"/><path fill=\"black\" stroke=\"white\" stroke-width=\"12\" d=\"M 614.35 287.95\nQ 602.2 275.8 584.95 275.8 567.7 275.8 555.5 287.95 543.35 300.15 543.35 317.4 543.35 334.65 555.5 346.8 567.7 359 584.95 359 602.2 359 614.35 346.8 626.55 334.65 626.55 317.4 626.55 300.15 614.35 287.95\n M 723.15 287.95\nQ 711 275.8 693.75 275.8 676.5 275.8 664.3 287.95 652.15 300.15 652.15 317.4 652.15 334.65 664.3 346.8 676.5 359 693.75 359 711 359 723.15 346.8 735.35 334.65 735.35 317.4 735.35 300.15 723.15 287.95 Z\"/></mask></defs><g mask=\"url(#cut)\"><path fill=\"#eee8d8\" d=\"\nM 681.95 456.6\nL 681.95 431.7\nQ 663.55 409.8 643.45 431.7\nL 643.45 458.95\nQ 662.7 458.8 681.95 456.6\nM 681.95 456.6\nQ 715.4142578125 461.9892578125 713.9 427.8 696.65 415.05 681.95 431.7\nL 681.95 456.6\nM 784 310.15\nL 784 310.1\nQ 784 266.95 748.55 236.4 713.15 205.9 663.05 205.9\nL 617 205.9\nQ 566.9 205.9 531.45 236.4 496.05 266.95 496.05 310.1\nL 496.05 310.15\nQ 493.2 353.05 511.5 374.3 529.75 395.55 566.1 394.6\nL 566.1 427.15\nQ 584.7 408.15 603.3 432.75 623.4 411.95 643.45 431.7 663.55 409.8 681.95 431.7 696.65 415.05 713.9 427.8\nL 713.9 397.35\nQ 738.75 402.4 761.55 381.5 784.35 360.55 784 310.15\nM 693.75 275.8\nQ 711 275.8 723.15 287.95 735.35 300.15 735.35 317.4 735.35 334.65 723.15 346.8 711 359 693.75 359 676.5 359 664.3 346.8 652.15 334.65 652.15 317.4 652.15 300.15 664.3 287.95 676.5 275.8 693.75 275.8\nM 584.95 275.8\nQ 602.2 275.8 614.35 287.95 626.55 300.15 626.55 317.4 626.55 334.65 614.35 346.8 602.2 359 584.95 359 567.7 359 555.5 346.8 543.35 334.65 543.35 317.4 543.35 300.15 555.5 287.95 567.7 275.8 584.95 275.8\nM 648.7 360.15\nQ 651.3 360.15 654.85 368.05 658.45 375.85 658.35 383.4 658.2 390.9 657 393.5 655.8 396 651.3 396.5 646.85 396.95 644.6 392.5\nL 644.6 364.75\nQ 646.35 360.15 648.7 360.15\nM 631.55 360.15\nQ 633.9 360.15 635.65 364.75\nL 635.65 392.5\nQ 633.4 396.95 628.95 396.5 624.45 396 623.25 393.5 622.05 390.9 621.95 383.4 621.8 375.85 625.4 368.05 628.95 360.15 631.55 360.15\nM 603.3 457.15\nL 603.3 432.75\nQ 584.7 408.15 566.1 427.15 563.0693359375 462.9853515625 603.3 457.15\nM 643.45 431.7\nQ 623.4 411.95 603.3 432.75\nL 603.3 457.15\nQ 623.4 459.15 643.45 458.95\nL 643.45 431.7 Z\"/><path fill=\"#161419\" d=\"M 635.65 364.75\nQ 633.9 360.15 631.55 360.15 628.95 360.15 625.4 368.05 621.8 375.85 621.95 383.4 622.05 390.9 623.25 393.5 624.45 396 628.95 396.5 633.4 396.95 635.65 392.5\nL 635.65 364.75\n M 654.85 368.05\nQ 651.3 360.15 648.7 360.15 646.35 360.15 644.6 364.75\nL 644.6 392.5\nQ 646.85 396.95 651.3 396.5 655.8 396 657 393.5 658.2 390.9 658.35 383.4 658.45 375.85 654.85 368.05\n\"/><path fill=\"none\" stroke=\"#161419\" stroke-width=\"12\" stroke-linejoin=\"round\" stroke-linecap=\"round\" d=\"\nM 735.35 317.4\nQ 735.35 334.65 723.15 346.8 711 359 693.75 359 676.5 359 664.3 346.8 652.15 334.65 652.15 317.4 652.15 300.15 664.3 287.95 676.5 275.8 693.75 275.8 711 275.8 723.15 287.95 735.35 300.15 735.35 317.4 Z\nM 617 205.9\nL 663.05 205.9\nQ 713.15 205.9 748.55 236.4 784 266.95 784 310.1\nL 784 310.15\nQ 784.35 360.55 761.55 381.5 738.75 402.4 713.9 397.35\nL 713.9 427.8\nQ 715.4142578125 461.9892578125 681.95 456.6 662.7 458.8 643.45 458.95 623.4 459.15 603.3 457.15 563.0693359375 462.9853515625 566.1 427.15\nL 566.1 394.6\nQ 529.75 395.55 511.5 374.3 493.2 353.05 496.05 310.15\nL 496.05 310.1\nQ 496.05 266.95 531.45 236.4 566.9 205.9 617 205.9 Z\nM 566.1 427.15\nQ 584.7 408.15 603.3 432.75 623.4 411.95 643.45 431.7 663.55 409.8 681.95 431.7 696.65 415.05 713.9 427.8\nM 681.95 431.7\nL 681.95 456.6\nM 626.55 317.4\nQ 626.55 334.65 614.35 346.8 602.2 359 584.95 359 567.7 359 555.5 346.8 543.35 334.65 543.35 317.4 543.35 300.15 555.5 287.95 567.7 275.8 584.95 275.8 602.2 275.8 614.35 287.95 626.55 300.15 626.55 317.4 Z\nM 643.45 431.7\nL 643.45 458.95\nM 603.3 432.75\nL 603.3 457.15\"/></g></svg>";
  const PUMPKIN_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"770\" height=\"750\" viewBox=\"450 210 385 375\"><defs><mask id=\"cut\" maskUnits=\"userSpaceOnUse\" x=\"450\" y=\"210\" width=\"385\" height=\"375\"><rect x=\"450\" y=\"210\" width=\"385\" height=\"375\" fill=\"white\"/><path fill=\"black\" stroke=\"white\" stroke-width=\"12\" d=\"M 693.75 357.95\nQ 711 357.95 723.15 370.1 735.35 382.3 735.35 399.55 735.35 416.8 723.15 428.95 711 441.15 693.75 441.15 676.5 441.15 664.3 428.95 652.15 416.8 652.15 399.55 652.15 382.3 664.3 370.1 676.5 357.95 693.75 357.95\n M 584.95 357.95\nQ 602.2 357.95 614.35 370.1 626.55 382.3 626.55 399.55 626.55 416.8 614.35 428.95 602.2 441.15 584.95 441.15 567.7 441.15 555.5 428.95 543.35 416.8 543.35 399.55 543.35 382.3 555.5 370.1 567.7 357.95 584.95 357.95\n M 709.85 533.85\nQ 706.4287109375 520.53359375 698.8 512.35 688.617578125 510.5666015625 677.7 520.4 674.4263671875 531.6669921875 677.7 546.65 657.5095703125 551.5240234375 634.75 549.85 629.490234375 549.4939453125 624.45 548.85 627.775 538.6875 624.55 528.5 610.425 517.15234375 596.3 520.4 588.5201171875 529.1205078125 587.75 539.9 570.4517578125 533.2376953125 556.95 522.25 527.2498046875 498.154296875 517.1 445.25 537.3326171875 467.1634765625 559.65 478.55 553.8470703125 488.9556640625 554.1 499.75 562.4357421875 510.3927734375 580.3 509.7 591.0984375 499.8625 592.6 490 612.9798828125 494.41015625 637.35 494.15 671.2 493.8447265625 698.4 486 698.769140625 494.4125 706 503.95 718.325 503.61640625 730.65 496.05 732.7494140625 483.8435546875 727.65 474.75 751.28203125 462.9552734375 765.6 440.45 756.1 502.1455078125 719.45 527.75 714.77109375 531.0392578125 709.85 533.85 Z\"/></mask></defs><g mask=\"url(#cut)\"><path fill=\"#4B3E2E\" d=\"\nM 630.1 282.7\nQ 633.947265625 282.5431640625 637.85 286.7 639.1615234375 284.3076171875 641.85 283.15 644.5384765625 281.9923828125 647.85 282.6 640.8125 248.2 670.5 235.4 663.6548828125 221.0419921875 646.95 218.1 612.5267578125 247.75390625 630.1 282.7 Z\"/><path fill=\"#F78D18\" d=\"\nM 679 282.1\nQ 696.8 284.65 712.9 292.65 730.5 301.4 742.75 315 756.4 330.2 761.9 349.8 756.4 330.2 742.75 315 730.5 301.4 712.9 292.65 696.8 284.65 679 282.1 662 279.6 647.85 282.6 644.5384765625 281.9923828125 641.85 283.15 639.1615234375 284.3076171875 637.85 286.7 650.7548828125 299.0671875 649.2 328.75 650.7548828125 299.0671875 637.85 286.7 633.947265625 282.5431640625 630.1 282.7 599.15 278.6 571.05 296.3 542.3 314.4 524.55 350.35 542.3 314.4 571.05 296.3 599.15 278.6 630.1 282.7 543.0541015625 254.5748046875 500.85 308.9 458.6982421875 363.2330078125 460.15 436.8 461.6083984375 510.3650390625 510.5 542.85 559.3990234375 575.3923828125 638.75 576.55 718.095703125 577.7583984375 772.7 546.95 827.303515625 516.183203125 824.55 438.8 821.8498046875 361.414453125 777.95 306.2 734.0416015625 251.030859375 647.85 282.6 662 279.6 679 282.1\nM 693.75 357.95\nQ 711 357.95 723.15 370.1 735.35 382.3 735.35 399.55 735.35 416.8 723.15 428.95 711 441.15 693.75 441.15 676.5 441.15 664.3 428.95 652.15 416.8 652.15 399.55 652.15 382.3 664.3 370.1 676.5 357.95 693.75 357.95\nM 584.95 357.95\nQ 602.2 357.95 614.35 370.1 626.55 382.3 626.55 399.55 626.55 416.8 614.35 428.95 602.2 441.15 584.95 441.15 567.7 441.15 555.5 428.95 543.35 416.8 543.35 399.55 543.35 382.3 555.5 370.1 567.7 357.95 584.95 357.95\nM 637.2 463.4\nL 616.6 471.15\nQ 619.353515625 446.9380859375 637.2 432 654.493359375 449.84765625 659.35 471.15\nL 637.2 463.4\nM 709.85 533.85\nQ 706.4287109375 520.53359375 698.8 512.35 688.617578125 510.5666015625 677.7 520.4 674.4263671875 531.6669921875 677.7 546.65 657.5095703125 551.5240234375 634.75 549.85 629.490234375 549.4939453125 624.45 548.85 627.775 538.6875 624.55 528.5 610.425 517.15234375 596.3 520.4 588.5201171875 529.1205078125 587.75 539.9 570.4517578125 533.2376953125 556.95 522.25 527.2498046875 498.154296875 517.1 445.25 537.3326171875 467.1634765625 559.65 478.55 553.8470703125 488.9556640625 554.1 499.75 562.4357421875 510.3927734375 580.3 509.7 591.0984375 499.8625 592.6 490 612.9798828125 494.41015625 637.35 494.15 671.2 493.8447265625 698.4 486 698.769140625 494.4125 706 503.95 718.325 503.61640625 730.65 496.05 732.7494140625 483.8435546875 727.65 474.75 751.28203125 462.9552734375 765.6 440.45 756.1 502.1455078125 719.45 527.75 714.77109375 531.0392578125 709.85 533.85 Z\"/><path fill=\"#161419\" d=\"\nM 616.6 471.15\nL 637.2 463.4 659.35 471.15\nQ 654.493359375 449.84765625 637.2 432 619.353515625 446.9380859375 616.6 471.15 Z\"/><path fill=\"none\" stroke=\"#161419\" stroke-width=\"12\" stroke-linejoin=\"round\" stroke-linecap=\"round\" d=\"\nM 647.85 282.625\nQ 662 279.6 679 282.1 696.8 284.65 712.9 292.65 730.5 301.4 742.75 315 756.4 330.2 761.9 349.8\nM 735.35 399.55\nQ 735.35 416.8 723.15 428.95 711 441.15 693.75 441.15 676.5 441.15 664.3 428.95 652.15 416.8 652.15 399.55 652.15 382.3 664.3 370.1 676.5 357.95 693.75 357.95 711 357.95 723.15 370.1 735.35 382.3 735.35 399.55 Z\nM 559.65 478.575\nQ 537.3326171875 467.1634765625 517.1 445.25 527.2498046875 498.154296875 556.95 522.275 570.4517578125 533.2376953125 587.75 539.925 588.5201171875 529.1205078125 596.3 520.4 610.425 517.15234375 624.55 528.5 627.775 538.6875 624.45 548.875 629.490234375 549.4939453125 634.75 549.875 657.5095703125 551.5240234375 677.7 546.65 674.4263671875 531.6669921875 677.7 520.4 688.617578125 510.5666015625 698.8 512.35 706.4287109375 520.53359375 709.875 533.85 714.77109375 531.0392578125 719.475 527.75 756.1 502.1455078125 765.6 440.45 751.28203125 462.9552734375 727.65 474.75 732.7494140625 483.8435546875 730.65 496.05 718.325 503.61640625 706 503.95 698.769140625 494.4125 698.4 486 671.2 493.8447265625 637.35 494.175 612.9798828125 494.41015625 592.6 490.025 591.0984375 499.8625 580.3 509.7 562.4357421875 510.3927734375 554.1 499.75 553.8470703125 488.9556640625 559.65 478.575 Z\nM 647.85 282.625\nQ 734.0416015625 251.030859375 777.95 306.225 821.8498046875 361.414453125 824.575 438.8 827.303515625 516.183203125 772.7 546.975 718.095703125 577.7583984375 638.75 576.575 559.3990234375 575.3923828125 510.5 542.875 461.6083984375 510.3650390625 460.15 436.8 458.6982421875 363.2330078125 500.875 308.9 543.0541015625 254.5748046875 630.1 282.7 612.5267578125 247.75390625 646.95 218.1 663.6548828125 221.0419921875 670.5 235.4 640.8125 248.2 647.85 282.625 644.5384765625 281.9923828125 641.85 283.15 639.1615234375 284.3076171875 637.85 286.7 650.7548828125 299.0671875 649.2 328.75\nM 637.85 286.7\nQ 633.947265625 282.5431640625 630.1 282.7 599.15 278.6 571.05 296.3 542.3 314.4 524.55 350.35\nM 626.55 399.55\nQ 626.55 416.8 614.35 428.95 602.2 441.15 584.95 441.15 567.7 441.15 555.5 428.95 543.35 416.8 543.35 399.55 543.35 382.3 555.5 370.1 567.7 357.95 584.95 357.95 602.2 357.95 614.35 370.1 626.55 382.3 626.55 399.55 Z\nM 637.2 432\nQ 619.353515625 446.9380859375 616.6 471.15\nL 637.2 463.4 659.35 471.15\nQ 654.493359375 449.84765625 637.2 432 Z\"/></g></svg>";
  const TAU = Math.PI * 2;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const hexToRgb = (hex) => { const value = Number.parseInt(String(hex).replace('#', ''), 16); return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255]; };

  // Size glyphs and distribute their anchors independently; then enforce margins around the full face.
  function faceLayout(expression, aspect, browThickness) {
    aspect=Math.max(.001,aspect);
    const ease=value=>{const t=clamp(value,0,1);return t*t*(3-2*t);};
    const tall=ease((1/aspect-1)/1.7), wide=ease((aspect-1)/1.6);
    const spreadX=1+.15*wide, spreadY=1+.55*tall;
    const variation=expression.variation || [1,1,1,1];
    // One shared envelope: expression changes never move or resize the face.
    const presets=Object.values(EXPRESSIONS);
    const envelope=presets.length ? presets : [{eyeTilt:.12,browLift:.36,browAsym:-.7855,browTilt:-1.36,browArch:1,mouthWidth:1.04}];
    const maximum=fn=>Math.max(...envelope.map(fn));
    const eyeSizeSpacing=.7+.3*ease((variation[1]-1/1.4)/(1-1/1.4));
    const browEyeOffset=.20475*(variation[1]-1);
    const spacing=.276*variation[0]*spreadX*eyeSizeSpacing, eyeRadius=.20475*variation[1];
    const eyeTop=.17*spreadY+maximum(p=>Math.abs((p.eyeTilt || 0)*.055))+eyeRadius;
    const browTop=.432*spreadY+browEyeOffset+maximum(p=>(p.browLift || 0)*.12+Math.abs((p.browAsym || 0)*.055)+Math.max(0,-(p.browTilt || 0)*.08)+.0585*(p.browArch || 0))+.035*Math.max(1,browThickness)+.02;
    const top=Math.max(eyeTop,browTop)+.015;
    const mouthBottom=-.51;
    const bottom=mouthBottom-.2*(spreadY-1);
    const halfHeight=(top-bottom)/2, centerY=(top+bottom)/2;
    const halfWidth=Math.max(spacing+eyeRadius,.455*spreadX,.31*maximum(p=>p.mouthWidth || 1)*variation[3])+.02;
    const middleSizeBoost=1+.326*(1-ease(Math.abs(Math.log(aspect))/Math.log(2.1)));
    const maximumHeightBoost=1+.10*ease((1/aspect-1)/1.1);
    const targetSize=(.85+.60*tall-.18*wide)*middleSizeBoost*maximumHeightBoost;
    const fit=Math.min(.78/halfWidth,.78/(aspect*halfHeight),targetSize);
    return [fit,aspect*fit,0,centerY,spreadX,spreadY];
  }

  function devilHorn(side) {
    const positions=[0,-.5,0],indices=[],segments=10,levels=[0,.15,.30,.45,.60,.75,.86,.90,.94,.97],rows=levels.length,capRadius=.5*Math.pow(.1,.8);
    for(let j=0;j<rows;j++){
      const t=levels[j],bend=Math.min(t,.90),r=t<=.90?.5*Math.pow(1-t,.8):Math.sqrt(Math.max(0,capRadius*capRadius-(t-.90)*(t-.90))),cx=side*(.85*bend-.55*bend*bend);
      for(let i=0;i<segments;i++){const a=-Math.PI+i/segments*TAU;positions.push(cx+Math.sin(a)*r,t-.5,Math.cos(a)*r+.05*t*t);}
    }
    for(let i=0;i<segments;i++)indices.push(0,1+(i+1)%segments,1+i);
    for(let j=0;j<rows-1;j++)for(let i=0;i<segments;i++){const a=1+j*segments+i,b=1+j*segments+(i+1)%segments;indices.push(a,b,a+segments,a+segments,b,b+segments);}
    const tip=positions.length/3;positions.push(side*(.85*.9-.55*.9*.9),.4+capRadius,.05*Math.pow(.9+capRadius,2));
    for(let i=0;i<segments;i++)indices.push(1+(rows-1)*segments+i,1+(rows-1)*segments+(i+1)%segments,tip);
    return {positions:new Float32Array(positions),indices:new Uint16Array(indices)};
  }

  function santaCrown(){
    const positions=[0,-.5,0],indices=[],segments=16,rows=14,bendRadius=.65,bendAngle=1.8;
    const curve=t=>{
      if(t<=.65){const angle=t*bendAngle;return {angle,x:bendRadius*(1-Math.cos(angle)),y:-.5+bendRadius*Math.sin(angle)};}
      const start=.65*bendAngle,angle=start+(t-.65)/.35*1.3,r=.35;
      return {angle,x:bendRadius*(1-Math.cos(start))+r*(Math.cos(start)-Math.cos(angle)),y:-.5+bendRadius*Math.sin(start)+r*(Math.sin(angle)-Math.sin(start))};
    };
    // The tighter upper arc starts after the cone has narrowed enough to clear its bend radius.
    for(let j=0;j<rows;j++){
      const t=j/rows,{angle,x:cx,y:cy}=curve(t),r=.5*Math.pow(1-t,.85);
      for(let i=0;i<segments;i++){
        const a=-Math.PI+i/segments*TAU,offset=Math.sin(a)*r;
        positions.push(cx+Math.cos(angle)*offset,cy-Math.sin(angle)*offset,Math.cos(a)*r);
      }
    }
    for(let i=0;i<segments;i++)indices.push(0,1+(i+1)%segments,1+i);
    for(let j=0;j<rows-1;j++)for(let i=0;i<segments;i++){const a=1+j*segments+i,b=1+j*segments+(i+1)%segments;indices.push(a,b,a+segments,a+segments,b,b+segments);}
    const tip=positions.length/3,end=curve(1);positions.push(end.x,end.y,0);
    for(let i=0;i<segments;i++)indices.push(1+(rows-1)*segments+i,1+(rows-1)*segments+(i+1)%segments,tip);
    return {positions:new Float32Array(positions),indices:new Uint16Array(indices)};
  }

  function elfCrown(){
    const mesh=santaCrown();
    for(let i=0;i<mesh.positions.length;i+=3)mesh.positions[i]*=-1;
    for(let i=0;i<mesh.indices.length;i+=3){const a=mesh.indices[i];mesh.indices[i]=mesh.indices[i+2];mesh.indices[i+2]=a;}
    return mesh;
  }
  function maskStrokeWidth(svgWidth,worldWidth,depth,fov,viewportHeight){
    const pixels=worldWidth*viewportHeight/(2*Math.tan(fov*.5)*Math.max(.1,depth));
    return Math.max(1,Math.round(1.75*svgWidth/Math.max(1,pixels)*4)/4);
  }

  function flatLens(ring=false,square=false) {
    const positions=[],indices=[],segments=32;
    for(let i=0;i<segments;i++) {
      const a=i/segments*TAU;
      const curve=v=>square?Math.sign(v)*Math.pow(Math.abs(v),.28):v;
      const x=curve(Math.cos(a)),y=curve(Math.sin(a));
      positions.push(x*.5,y*.5,0);
      positions.push(x*(ring?.38525:0),y*(ring?.38525:0),0);
    }
    for(let i=0;i<segments;i++){const a=i*2,b=((i+1)%segments)*2;indices.push(a,b,a+1);if(ring)indices.push(a+1,b,b+1);}
    return {positions:new Float32Array(positions),indices:new Uint16Array(indices)};
  }

  function multiply4(a, b) {
    const out = new Float32Array(16);
    for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1] + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
    }
    return out;
  }

  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2), range = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * range, -1, 0, 0, far * near * 2 * range, 0]);
  }

  function lookAt(eye, target, worldUp = [0, 1, 0]) {
    let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2], length = Math.hypot(zx, zy, zz) || 1; zx /= length; zy /= length; zz /= length;
    let xx = worldUp[1] * zz - worldUp[2] * zy, xy = worldUp[2] * zx - worldUp[0] * zz, xz = worldUp[0] * zy - worldUp[1] * zx; length = Math.hypot(xx, xy, xz) || 1; xx /= length; xy /= length; xz /= length;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * eye[0] + xy * eye[1] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1]);
  }

  function rotation(yaw, pitch = 0, roll = 0) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch), cz = Math.cos(roll), sz = Math.sin(roll);
    return [cy * cz + sy * sx * sz, cx * sz, -sy * cz + cy * sx * sz, -cy * sz + sy * sx * cz, cx * cz, sy * sz + cy * sx * cz, sy * cx, -sx, cy * cx];
  }

  function modelMatrix(x, y, z, yaw, sx, sy, sz, pitch = 0, roll = 0) {
    const r = rotation(yaw, pitch, roll);
    return new Float32Array([r[0] * sx, r[1] * sx, r[2] * sx, 0, r[3] * sy, r[4] * sy, r[5] * sy, 0, r[6] * sz, r[7] * sz, r[8] * sz, 0, x, y, z, 1]);
  }

  function normalMatrix(yaw, sx, sy, sz, pitch = 0, roll = 0) {
    const r = rotation(yaw, pitch, roll);
    return new Float32Array([r[0] / sx, r[1] / sx, r[2] / sx, r[3] / sy, r[4] / sy, r[5] / sy, r[6] / sz, r[7] / sz, r[8] / sz]);
  }

  function normalFromModel(m) {
    const a=[m[0],m[1],m[2]],b=[m[4],m[5],m[6]],c=[m[8],m[9],m[10]];
    const cross=(u,v)=>[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const x=cross(b,c),y=cross(c,a),z=cross(a,b),det=a[0]*x[0]+a[1]*x[1]+a[2]*x[2];
    return new Float32Array([...x,...y,...z].map(v=>v/det));
  }
  export function armObjects(object) {
    const p=object.member.armParams;if(!object.member.body.arms || !p)return [];
    const parent=modelMatrix(object.x,object.y,object.z,object.yaw,object.scaleX ?? 1,object.scaleY ?? 1,object.scaleZ ?? 1,object.pitch ?? 0,object.roll ?? 0);
    let armPalette=object.member.palette;
    if(object.member.gradient){
      const base=hexToRgb(armPalette),sum=Math.max(...base)+Math.min(...base);
      const top=object.member.gradientComplement?hexToRgb(object.member.gradientComplement):base.map(c=>sum-c);
      armPalette='#'+base.map((c,i)=>Math.round((c+top[i])*.5*255).toString(16).padStart(2,'0')).join('');
    }
    return [-1,1].map(side=>{
      const q=p.cosY*p.cosY+p.sinY*p.sinY;
      const local=new Float32Array([
        side*p.cosA*p.cosY*2*p.a/q,-p.sinA*p.cosY*2*p.a/q,-p.sinY*2*p.a/q,0,
        p.sinA*2*p.b,side*p.cosA*2*p.b,0,0,
        side*p.cosA*p.sinY*2*p.c/q,-p.sinA*p.sinY*2*p.c/q,p.cosY*2*p.c/q,0,
        side*(p.rootX+p.centerFx*p.cosY*p.cosA/q),p.rootY-p.centerFx*p.cosY*p.sinA/q,-p.centerFx*p.sinY/q,1]);
      const customModel=multiply4(parent,local);
      return {...object,face:false,isArm:true,customModel,customNormal:normalFromModel(customModel),member:{...object.member,palette:armPalette,gradient:false,body:{...object.member.body,stripes:false,shape:'sphere',lowPoly:true,width:2*p.a,height:2*p.b,depth:2*p.c,arms:false},hatParts:[],armParams:null,glasses:'none'}};
    });
  }

  function accumulateNormals(positions, indices) {
    const normals = new Float32Array(positions.length);
    for (let index = 0; index < indices.length; index += 3) {
      const ia = indices[index] * 3, ib = indices[index + 1] * 3, ic = indices[index + 2] * 3;
      const abx = positions[ib] - positions[ia], aby = positions[ib + 1] - positions[ia + 1], abz = positions[ib + 2] - positions[ia + 2], acx = positions[ic] - positions[ia], acy = positions[ic + 1] - positions[ia + 1], acz = positions[ic + 2] - positions[ia + 2];
      const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
      [ia, ib, ic].forEach((offset) => { normals[offset] += nx; normals[offset + 1] += ny; normals[offset + 2] += nz; });
    }
    for (let index = 0; index < normals.length; index += 3) { const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]) || 1; normals[index] /= length; normals[index + 1] /= length; normals[index + 2] /= length; }
    return normals;
  }

  function superellipsoid(exponent, longitudeSegments = 18, latitudeSegments = 12) {
    const positions=[0,-.5,0],indices=[];
    const signedPow=(value,power)=>Math.abs(value)<1e-12?0:Math.sign(value)*Math.pow(Math.abs(value),power);
    for(let latitude=1;latitude<latitudeSegments;latitude++) {
      const theta=-Math.PI/2+latitude/latitudeSegments*Math.PI,ring=signedPow(Math.cos(theta),exponent);
      for(let longitude=0;longitude<longitudeSegments;longitude++) {
        const phi=-Math.PI+longitude/longitudeSegments*TAU;
        positions.push(.5*ring*signedPow(Math.sin(phi),exponent),.5*signedPow(Math.sin(theta),exponent),.5*ring*signedPow(Math.cos(phi),exponent));
      }
    }
    const top=positions.length/3;positions.push(0,.5,0);
    for(let longitude=0;longitude<longitudeSegments;longitude++) {
      const next=(longitude+1)%longitudeSegments;
      indices.push(0,1+next,1+longitude);
      for(let row=0;row<latitudeSegments-2;row++) {
        const a=1+row*longitudeSegments+longitude,aNext=1+row*longitudeSegments+next,b=a+longitudeSegments,bNext=aNext+longitudeSegments;
        indices.push(a,aNext,b,b,aNext,bNext);
      }
      const last=1+(latitudeSegments-2)*longitudeSegments;
      indices.push(last+longitude,last+next,top);
    }
    return {positions:new Float32Array(positions),indices:new Uint16Array(indices)};
  }

  function ghostSheet(body){
    const shape=body.ghostShape,exponent=shape==='cube'?(.10+(.15-.10)/.42*.58):shape==='roundedBox'?(.10+(.4-.10)/.42*.58):1;
    const source=shape==='capsule'?capsule(body,32,12):superellipsoid(exponent,32,24);
    const normals=accumulateNormals(source.positions,source.indices),positions=[],indices=[],mapping=new Map(),rim=[];
    const dims=[body.width,body.height,body.depth];
    const vertex=index=>({p:Array.from(source.positions.slice(index*3,index*3+3)),n:Array.from(normals.slice(index*3,index*3+3))});
    const add=v=>{
      const key=v.p.map(x=>x.toFixed(6)).join('|');if(mapping.has(key))return mapping.get(key);
      const index=positions.length/3;mapping.set(key,index);
      const n=v.n.map((x,k)=>x/dims[k]),length=Math.hypot(...n)||1;
      for(let k=0;k<3;k++)positions.push(v.p[k]+.055*n[k]/length/dims[k]);
      if(Math.abs(v.p[1])<1e-6)rim.push(index);
      return index;
    };
    // Clip at the actual equator: tall capsules have no existing ring there.
    for(let i=0;i<source.indices.length;i+=3){
      const triangle=Array.from(source.indices.slice(i,i+3),vertex),polygon=[];
      for(let j=0;j<3;j++){
        const a=triangle[j],b=triangle[(j+1)%3],inside=a.p[1]>=0;
        if(inside)polygon.push(a);
        if(inside!==(b.p[1]>=0)){
          const t=-a.p[1]/(b.p[1]-a.p[1]);
          polygon.push({p:a.p.map((x,k)=>k===1?0:x+(b.p[k]-x)*t),n:a.n.map((x,k)=>x+(b.n[k]-x)*t)});
        }
      }
      for(let j=1;j+1<polygon.length;j++){const tri=[add(polygon[0]),add(polygon[j]),add(polygon[j+1])];if(new Set(tri).size===3)indices.push(...tri);}
    }
    rim.sort((a,b)=>Math.atan2(positions[a*3],positions[a*3+2])-Math.atan2(positions[b*3],positions[b*3+2]));
    for(let row=1;row<=6;row++)for(const index of rim){const x=positions[index*3],z=positions[index*3+2],angle=Math.atan2(x,z),t=row/6;positions.push(x*(1+.09*t),-.6732*t+Math.cos(angle*8)*.035*t*t,z*(1+.09*t));}
    for(let row=0;row<6;row++)for(let j=0;j<rim.length;j++){const next=(j+1)%rim.length,a=row===0?rim[j]:mapping.size+(row-1)*rim.length+j,b=row===0?rim[next]:mapping.size+(row-1)*rim.length+next,c=mapping.size+row*rim.length+j,d=mapping.size+row*rim.length+next;indices.push(a,c,b,b,c,d);}
    return {positions:new Float32Array(positions),indices:new Uint16Array(indices)};
  }

  function hemisphere() {
    const source=superellipsoid(1),positions=[],indices=[],mapping=new Map(),rim=[];
    for(let i=0;i<source.positions.length;i+=3)if(source.positions[i+1]>=-1e-8){
      const index=positions.length/3;mapping.set(i/3,index);
      positions.push(source.positions[i],source.positions[i+1]*2-.5,source.positions[i+2]);
      if(Math.abs(source.positions[i+1])<1e-8)rim.push(index);
    }
    for(let i=0;i<source.indices.length;i+=3){
      const triangle=Array.from(source.indices.slice(i,i+3));
      if(triangle.every(index=>mapping.has(index)))indices.push(...triangle.map(index=>mapping.get(index)));
    }
    const centre=positions.length/3;positions.push(0,-.5,0);
    for(let i=0;i<rim.length;i++)indices.push(centre,rim[(i+1)%rim.length],rim[i]);
    return {positions:new Float32Array(positions),indices:new Uint16Array(indices)};
  }

  function lathe(profile,segments=24) {
    const positions=[],indices=[],rows=[];
    profile.forEach(([radius,y])=>{
      const row=[];
      if(radius<1e-8){row.push(positions.length/3);positions.push(0,y,0);}
      else for(let i=0;i<segments;i++){const angle=-Math.PI+i/segments*TAU;row.push(positions.length/3);positions.push(Math.sin(angle)*radius,y,Math.cos(angle)*radius);}
      rows.push(row);
    });
    for(let j=0;j<rows.length-1;j++)for(let i=0;i<segments;i++){
      const a=rows[j],b=rows[j+1],next=(i+1)%segments;
      if(a.length===1)indices.push(a[0],b[next],b[i]);
      else if(b.length===1)indices.push(a[i],a[next],b[0]);
      else indices.push(a[i],a[next],b[i],b[i],a[next],b[next]);
    }
    return {positions:new Float32Array(positions),indices:new Uint16Array(indices)};
  }
  function bowlerCrown() {
    const profile=[[0,-.5],[.5,-.5],[.5,-.1]];
    for(let i=1;i<=8;i++){const angle=i/8*Math.PI/2;profile.push([i===8?0:.5*Math.cos(angle),-.1+.6*Math.sin(angle)]);}
    return lathe(profile);
  }
  function bowlerBrim() {
    return lathe([[0,-.5],[.35,-.5],[.46,-.05],[.5,.35],[.49,.5],[.44,.25],[.32,-.05],[0,-.05]]);
  }

  function capVisor() {
    const mesh=superellipsoid(.4,24,8);
    return mesh;
  }

  function capsule(body, longitudeSegments = 24, capSegments = 8) {
    const width=Math.max(.001,body.width),height=Math.max(.001,body.height),depth=Math.max(.001,body.depth);
    const horizontal=width>height, length=horizontal?width:height;
    const radius=Math.min(width,height,depth)*.5, segment=Math.max(0,length*.5-radius);
    const positions=[],indices=[],rows=[];
    for(let step=0;step<=capSegments;step++) {
      const angle=-Math.PI/2+step/capSegments*Math.PI/2;
      rows.push({axis:-segment+Math.sin(angle)*radius,radius:Math.cos(angle)*radius});
    }
    for(let step=segment>1e-6?0:1;step<=capSegments;step++) {
      const angle=step/capSegments*Math.PI/2;
      rows.push({axis:segment+Math.sin(angle)*radius,radius:Math.cos(angle)*radius});
    }
    rows.forEach(row=>{for(let longitude=0;longitude<longitudeSegments;longitude++) {
      const angle=longitude/longitudeSegments*TAU,ringX=Math.sin(angle)*row.radius,z=Math.cos(angle)*row.radius;
      const x=horizontal?row.axis:ringX,y=horizontal?-ringX:row.axis;
      positions.push(x/width,y/height,z/depth);
    }});
    for(let row=0;row<rows.length-1;row++)for(let longitude=0;longitude<longitudeSegments;longitude++) {
      const next=(longitude+1)%longitudeSegments,a=row*longitudeSegments+longitude,an=row*longitudeSegments+next,b=a+longitudeSegments,bn=(row+1)*longitudeSegments+next;
      indices.push(a,an,b,b,an,bn);
    }
    return {positions:new Float32Array(positions),indices:new Uint16Array(indices)};
  }

  const ANTLER_OUTLINES = [[[-0.109659,0.442727],[-0.112841,0.440909],[-0.130771,0.430237],[-0.145013,0.415843],[-0.155568,0.397727],[-0.161714,0.376521],[-0.162092,0.355082],[-0.156477,0.333409],[-0.142011,0.289457],[-0.135371,0.249201],[-0.136557,0.212639],[-0.145568,0.179773],[-0.269886,0.502955],[-0.280251,0.522464],[-0.294569,0.537691],[-0.312841,0.548864],[-0.335208,0.55619],[-0.356723,0.556796],[-0.378523,0.551364],[-0.398297,0.540659],[-0.413828,0.525735],[-0.425114,0.506591],[-0.431591,0.48538],[-0.432121,0.46394],[-0.426705,0.442273],[-0.258295,0.004773],[-0.257159,0.001364],[-0.249205,-0.019773],[-0.251785,-0.017796],[-0.254432,-0.015682],[-0.283366,0.013558],[-0.310266,0.048883],[-0.336266,0.091428],[-0.361366,0.141195],[-0.385568,0.198182],[-0.396234,0.218001],[-0.411007,0.233304],[-0.429886,0.244318],[-0.451323,0.250862],[-0.472687,0.251241],[-0.494205,0.245682],[-0.514107,0.234802],[-0.529486,0.219954],[-0.540568,0.200909],[-0.54685,0.17976],[-0.54738,0.158472],[-0.542159,0.137273],[-0.515167,0.073189],[-0.487048,0.016179],[-0.457801,-0.033987],[-0.427427,-0.077306],[-0.395925,-0.11378],[-0.363295,-0.143409],[-0.327492,-0.169445],[-0.291636,-0.18844],[-0.254818,-0.201304],[-0.217038,-0.208036],[-0.178295,-0.208636],[-0.076932,-0.484773],[-0.074546,-0.489309],[-0.071023,-0.492955],[-0.066707,-0.495459],[-0.061932,-0.496591],[-0.05689,-0.496526],[-0.052159,-0.495],[0.067614,-0.437727],[0.073096,-0.433824],[0.076705,-0.428182],[0.078092,-0.421639],[0.076932,-0.415],[-0.043295,-0.085909],[-0.044425,-0.083111],[-0.074886,-0.003864],[-0.022626,0.044733],[0.013714,0.100527],[0.034136,0.163519],[0.038639,0.233709],[0.027222,0.311096],[-0.000114,0.395682],[-0.011055,0.415388],[-0.026131,0.430767],[-0.045341,0.441818],[-0.066755,0.447929],[-0.088195,0.448232]],[[0.31375,0.549545],[0.294442,0.537692],[0.280124,0.522464],[0.269659,0.503182],[0.145568,0.179773],[0.136542,0.212638],[0.135313,0.2492],[0.141883,0.289457],[0.15625,0.333409],[0.161991,0.355082],[0.161688,0.376521],[0.155341,0.397727],[0.144887,0.415843],[0.130644,0.430237],[0.112614,0.440909],[0.109432,0.442727],[0.088094,0.448232],[0.06673,0.447929],[0.045341,0.441818],[0.026131,0.430767],[0.011055,0.415388],[0.000114,0.395682],[-0.027379,0.311114],[-0.038754,0.233736],[-0.034237,0.16355],[-0.01383,0.100554],[0.022469,0.04475],[0.074659,-0.003864],[0.044886,-0.081591],[0.04375,-0.084545],[-0.076932,-0.415],[-0.078091,-0.421636],[-0.076705,-0.428182],[-0.073158,-0.433823],[-0.067841,-0.437727],[0.051932,-0.495],[0.056771,-0.496523],[0.061705,-0.496591],[0.06665,-0.495458],[0.071023,-0.492955],[0.074547,-0.489304],[0.076932,-0.484773],[0.178295,-0.208636],[0.217029,-0.208036],[0.254782,-0.201304],[0.291554,-0.18844],[0.327347,-0.169445],[0.362159,-0.144318],[0.395026,-0.114518],[0.426731,-0.078031],[0.457274,-0.034632],[0.486655,0.015681],[0.514874,0.072906],[0.541932,0.137045],[0.547254,0.158472],[0.546723,0.17976],[0.540341,0.201136],[0.529385,0.219954],[0.514082,0.234802],[0.494432,0.245455],[0.472662,0.251241],[0.451223,0.250863],[0.429886,0.244545],[0.41088,0.233304],[0.396108,0.218001],[0.385341,0.198409],[0.361221,0.141195],[0.336184,0.091428],[0.310229,0.048883],[0.283357,0.013558],[0.255568,-0.014545],[0.251707,-0.017816],[0.248977,-0.019773],[0.25625,-0.000909],[0.257287,0.001893],[0.426477,0.442273],[0.431994,0.46394],[0.431464,0.48538],[0.424886,0.506591],[0.413727,0.525735],[0.398272,0.540659],[0.378523,0.551364],[0.356698,0.556796],[0.335107,0.55619]]];
  function reindeerAntler(side){
    const outline=ANTLER_OUTLINES[side<0?0:1];
    const inset=outline.map((v,i)=>{
      const a=outline[(i+outline.length-1)%outline.length],b=outline[(i+1)%outline.length];
      const dx=v[0]-a[0],dy=v[1]-a[1],ex=b[0]-v[0],ey=b[1]-v[1],l=Math.hypot(dx,dy),m=Math.hypot(ex,ey);
      const n=[-dy/l,dx/l],q=[-ey/m,ex/m],sum=[n[0]+q[0],n[1]+q[1]],den=sum[0]*n[0]+sum[1]*n[1],distance=(.028/3)/Math.max(.25,den);
      return [v[0]+sum[0]*distance,v[1]+sum[1]*distance];
    });
    const positions=[],indices=[],remaining=outline.map((_,i)=>i),triangles=[];
    const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    while(remaining.length>3){let found=false;
      for(let i=0;i<remaining.length;i++){
        const a=remaining[(i+remaining.length-1)%remaining.length],b=remaining[i],c=remaining[(i+1)%remaining.length];
        if(cross(outline[a],outline[b],outline[c])<=0)continue;
        if(remaining.some(j=>j!==a&&j!==b&&j!==c&&cross(outline[a],outline[b],outline[j])>=0&&cross(outline[b],outline[c],outline[j])>=0&&cross(outline[c],outline[a],outline[j])>=0))continue;
        triangles.push([a,b,c]);remaining.splice(i,1);found=true;break;
      }if(!found)throw Error('Invalid antler outline');
    }triangles.push([...remaining]);
    const angle=0,cs=1,sn=0;
    const point=(i,z,inner=false)=>{const v=(inner?inset:outline)[i],x=v[0],y=v[1]+.45;return [cs*x-sn*y,sn*x+cs*y-.45,z];};
    const tri=(a,b,c)=>{const offset=positions.length/3;positions.push(...a,...b,...c);indices.push(offset,offset+1,offset+2);};
    for(const [a,b,c] of triangles){tri(point(a,.078,true),point(b,.078,true),point(c,.078,true));tri(point(c,-.078,true),point(b,-.078,true),point(a,-.078,true));}
    for(let i=0;i<outline.length;i++){
      const j=(i+1)%outline.length;
      tri(point(i,-(.078-.05/3)),point(j,-(.078-.05/3)),point(j,(.078-.05/3)));tri(point(i,-(.078-.05/3)),point(j,(.078-.05/3)),point(i,(.078-.05/3)));
      tri(point(i,(.078-.05/3)),point(j,(.078-.05/3)),point(j,.078,true));tri(point(i,(.078-.05/3)),point(j,.078,true),point(i,.078,true));
      tri(point(i,-.078,true),point(j,-.078,true),point(j,-(.078-.05/3)));tri(point(i,-.078,true),point(j,-(.078-.05/3)),point(i,-(.078-.05/3)));
    }
    return {positions:new Float32Array(positions),indices:new Uint16Array(indices)};
  }

  const GHOST_DEFORMATION = `vec3 deformGhost(vec3 point,float time,float ghost,vec2 motion){
      vec3 position=point;
      if(ghost>0.5){
        // Smooth influence over the full skirt, anchored at the body's equator.
        float influence=smoothstep(.035,.52,-position.y);
        float angle=atan(position.x,position.z);
        float wave=sin(angle*3.0+time*1.7)*.018+sin(angle*5.0-time*1.15)*.009;
        position.xz*=1.0+wave*influence;
        position.xz+=motion*influence;
        position.x+=sin(time*1.3+position.z*3.0)*.012*influence;
        position.y+=sin(angle*4.0+time*1.5)*.008*influence;
        // Keep a conservative inner envelope inside the sheet's resting clearance.
        // Axis limits also protect the flat sides of cube bodies during sharp turns.
        vec2 inner=max(abs(point.xz)-vec2(.012),vec2(0.0));
        if(point.x>0.012)position.x=max(position.x,inner.x);
        if(point.x<-.012)position.x=min(position.x,-inner.x);
        if(point.z>0.012)position.z=max(position.z,inner.y);
        if(point.z<-.012)position.z=min(position.z,-inner.y);
      }
      return position;
    }`;

  const BODY_VERTEX = `#version 300 es
    precision highp float;
    layout(location=0) in vec3 aPosition;
    layout(location=1) in vec3 aNormal;
    layout(location=2) in vec3 aBarycentric;
    out vec3 vBarycentric;
    uniform mat4 uModel;
    uniform mat4 uViewProjection;
    uniform mat4 uLightViewProjection;
    uniform mat3 uNormalMatrix;
    uniform vec2 uOutlineViewport;
    uniform float uOutlinePerspective;
    uniform float uOutline;
    out vec3 vWorld;
    out vec3 vNormal;
    out vec3 vLocal;
    out vec4 vShadow;
    uniform float uTime;
    uniform vec4 uSkull;
    uniform vec2 uClothMotion;
    ${GHOST_DEFORMATION}
    void main() {
      vec3 position=deformGhost(aPosition,uTime,uSkull.w>2.5?1.0:0.0,uClothMotion);
      vec4 world = uModel * vec4(position, 1.0);
      vec3 normal = normalize(uNormalMatrix * aNormal);
      vBarycentric=aBarycentric; vWorld = world.xyz; vNormal = normal; vLocal = aPosition * 2.0; vShadow = uLightViewProjection * world;
      vec4 clip = uViewProjection * world;
      if (uOutline > 0.0) {
        vec4 projectedNormal = uViewProjection * vec4(normal, 0.0);
        vec2 direction = (projectedNormal.xy * clip.w - clip.xy * projectedNormal.w) * uOutlineViewport;
        float magnitude = length(direction);
        if (magnitude > 0.00001) {
          // Constant CSS-pixel thickness, independent of object scale and camera distance.
          float pixels = (uOutline / 0.054) * 6.0;
          if (uOutlinePerspective > 0.0) pixels *= uOutlinePerspective / max(.1, clip.w);
          clip.xy += direction / magnitude * (2.0 * pixels / uOutlineViewport) * clip.w;
        }
      }
      gl_Position = clip;
    }`;

  const BODY_FRAGMENT = `#version 300 es
    precision highp float;
    in vec3 vBarycentric;
    in vec3 vWorld;
    in vec3 vNormal;
    in vec3 vLocal;
    in vec4 vShadow;
    uniform vec3 uBase;
    uniform float uGradient;
    uniform vec3 uGradientComplement;
    uniform float uHasGradientComplement;
    uniform float uGlitter;
    uniform vec3 uGlitterDimensions;
    uniform float uBrowThickness;
    uniform float uTime;
    uniform float uMouthReaction;
    uniform vec3 uExpressionDetails;
    uniform float uBrowSpacing;
    uniform float uBlinkClosure;
    uniform float uWinkBlink;
    uniform vec3 uCameraPosition;
    uniform vec3 uLightPosition[4];
    uniform float uLightDecay[4];
    uniform float uLightDirectional[4];
    uniform vec3 uLightTarget[4];
    uniform vec3 uLightColour[4];
    uniform float uLightPower[4];
    uniform float uLightRadius[4];
    uniform float uLightSpot[4];
    uniform float uLightCone[4];
    uniform float uLightFloorAspect[4];
    uniform float uFloorGlow;
    uniform vec3 uFloorBase;
    uniform vec3 uFloorHighlight;
    uniform float uAmbient;
    uniform float uOutline;
    uniform float uEmissive;
    uniform float uOpacity;
    uniform float uGlossy;
    uniform float uStripes;
    uniform float uKnit;
    uniform float uPreserveColour;
    uniform vec4 uSkull;
    uniform vec3 uMaskStrap;
    uniform sampler2D uSkullTexture;
    uniform vec4 uHatPanel;
    uniform vec4 uHatBand;
    uniform float uBands;
    uniform float uPixelDensity;
    uniform float uDither;
    uniform float uRenderMode;
    uniform float uColoured;
    uniform float uCanvasPalette;
    uniform float uPaletteGrayscale;
    uniform float uDisco;
    uniform float uFaceEnabled;
    uniform float uEyeCross;
    uniform float uIsFloor;
    uniform vec2 uEyeOpen;
    uniform vec2 uGaze;
    uniform vec4 uMouth;
    uniform float uSmileOpen;
    uniform float uMouthWave;
    uniform float uJoyEyes;
    uniform vec3 uBrow;
    uniform vec4 uFaceStyle;
    uniform vec4 uFaceVariation;
    uniform float uFaceAspect;
    uniform vec4 uFaceLayout;
    uniform vec2 uFaceSpread;
    uniform sampler2D uShadowMap;
    uniform float uHasShadow;
    out vec4 outColour;

    vec3 studioPalette(vec3 base, float tone) {
      if (uPaletteGrayscale > .5) return vec3(.035 + .93 * pow(tone,.86));
      float hi=max(base.r,max(base.g,base.b)),lo=min(base.r,min(base.g,base.b)),delta=hi-lo;
      float lightness=(hi+lo)*.5,saturation=delta<.00001?0.0:delta/max(.00001,1.0-abs(2.0*lightness-1.0));
      float hue=0.0;
      if(delta>.00001) {
        if(hi==base.r)hue=mod((base.g-base.b)/delta,6.0);
        else if(hi==base.g)hue=(base.b-base.r)/delta+2.0;
        else hue=(base.r-base.g)/delta+4.0;
        hue=fract(hue/6.0+1.0);
      }


      saturation=min(saturation,.90);
      lightness=.045+.91*pow(tone,.88);
      float chroma=(1.0-abs(2.0*lightness-1.0))*saturation;
      vec3 rgb=clamp(abs(mod(hue*6.0+vec3(0.0,4.0,2.0),6.0)-3.0)-1.0,0.0,1.0);
      return vec3(lightness)+chroma*(rgb-.5);
    }

    float ellipseSdf(vec2 point, vec2 radii) { return length(point / radii) - 1.0; }
    float lineSdf(vec2 point, vec2 a, vec2 b) { vec2 pa = point - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
    float hash21(vec2 point) { return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453); }
    // Ordered 4x4 pattern in final render pixels, rather than body coordinates.
    float bodyDither(vec2 pixel) {
      const float ranks[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
      ivec2 cell = ivec2(mod(floor(pixel), 4.0));
      return (ranks[cell.y * 4 + cell.x] + 0.5) / 16.0 - 0.5;
    }
    float shadowVisibility() {
      if (uHasShadow < .5) return 1.0;
      vec3 projected = vShadow.xyz / vShadow.w * .5 + .5;
      if (projected.x <= 0.0 || projected.x >= 1.0 || projected.y <= 0.0 || projected.y >= 1.0 || projected.z >= 1.0) return 1.0;
      float stored = texture(uShadowMap, projected.xy).r;
      return projected.z - .0001 > stored ? .38 : 1.0;
    }
    vec3 sampleProceduralEnv(vec3 r, float roughness) {
      float horizon=roughness<=.01 ? step(0.0,r.y) : 1.0/(1.0+exp(-r.y*mix(400.0,15.0,roughness)));
      vec3 sky=vec3(215,228,248)+r.y*vec3(30,22,6);
      vec3 floorColour=vec3(20,22,30)-r.y*vec3(12,14,16);
      if(r.y<-.01) floorColour+=exp(-dot(r.xz,r.xz)/(r.y*r.y*1.8))*vec3(110,120,145);
      vec3 colour=mix(floorColour,sky,horizon);
      colour+=exp(-pow(abs(r.y-.005),2.0)/mix(.0008,.006,roughness))*160.0*vec3(1,1.05,1.15);
      float p1=max(abs(r.x-.22)-.38,abs(r.y-.62)-.26);
      float p2=max(abs(r.x+.68)-.12,abs(r.y-.15)-.48);
      float p3=max(abs(r.x+.15)-.22,abs(r.y-.35)-.18);
      float f1=exp(-max(0.0,p1)*(roughness<=.02?60.0:mix(35.0,8.0,roughness)));
      float f2=exp(-max(0.0,p2)*(roughness<=.02?55.0:mix(30.0,6.0,roughness)));
      float f3=exp(-max(0.0,p3)*(roughness<=.02?50.0:mix(25.0,6.0,roughness)));
      if(f1>.001)colour+=f1*(roughness<=.02?260.0:200.0)*vec3(1,.98,.94);
      if(f2>.001)colour+=f2*(roughness<=.02?220.0:160.0)*vec3(.88,.96,1.12);
      if(r.z>.4 && f3>.001)colour+=f3*(roughness<=.02?180.0:130.0);
      return colour/255.0;
    }
    float faceEdge(float low, float high, float value) { return step((low + high) * .5, value); }
    void main() {
      vec3 maskBase=uBase;
      if(uSkull.w>2.5){
        vec2 eye=vec2(abs(vLocal.x)-uSkull.x,vLocal.y-uSkull.y);
        if(vLocal.z>0.0 && length(eye*vec2(1.0,uGlitterDimensions.y/uGlitterDimensions.x))<uSkull.z)discard;
        maskBase=vec3(.960784,.949020,.909804);
      }else if(uSkull.z>0.0){
        vec4 mask=texture(uSkullTexture,vec2(vLocal.x*.5+.5,.5-vLocal.y*.5));
        if(mask.a<.5)discard;
        float ink=step(dot(mask.rgb,vec3(.2126,.7152,.0722)),.50);
        vec3 maskColour=uSkull.w>1.5?vec3(.968627,.552941,.094118):vec3(.960784,.949020,.909804);
        maskBase=mix(maskColour,vec3(.086275,.078431,.098039),ink);
        if(uSkull.w>1.5 && mask.r>.20 && mask.r<.40 && mask.g>.15)maskBase=vec3(.294118,.243137,.180392);
      }
      float colourMax = max(uBase.r, max(uBase.g, uBase.b)), colourMin = min(uBase.r, min(uBase.g, uBase.b));
      vec3 complementary = mix(vec3(colourMax + colourMin) - uBase, uGradientComplement, uHasGradientComplement);
      vec3 surfaceBase = mix(uBase, complementary, abs(uGradient) * smoothstep(-1.0, 1.0, uGradient < 0.0 ? -vLocal.y : vLocal.y));
      if(uSkull.z>0.0)surfaceBase=maskBase;
      if (uOutline > 0.0) { outColour = vec4(surfaceBase * .06, 1.0); return; }
      vec3 normal = normalize(vNormal), lightTint = vec3(0.0); float direct = 0.0;
      if(uSkull.z>0.0 && !gl_FrontFacing)normal=-normal;
      // Physical body coordinates keep cubic flakes uniform across body proportions.
      // Base dimensions exclude breathing/squash, so the pattern stays attached during animation.
      vec3 glitterPosition = vLocal * .5 * uGlitterDimensions;
      vec3 flakeCell = floor(glitterPosition * 38.0);
      float flakeHash = fract(sin(dot(flakeCell, vec3(127.1, 311.7, 74.7))) * 43758.5453);
      bool hasFlake = uGlitter > .001 && uIsFloor < .5 && flakeHash >= 1.0 - min(1.0, uGlitter * 1.17);
      float flakePhase = fract(sin(dot(flakeCell, vec3(269.5, 183.3, 419.2))) * 43758.5453) * 6.283185;
      vec3 randomNormal = normalize(vec3(fract(flakeHash * 13.1), fract(flakeHash * 29.7), fract(flakeHash * 47.3)) - .5);
      vec3 microNormal = normalize(normal * .6 + randomNormal * .4);
      vec3 viewDirection = normalize(uCameraPosition - vWorld);
      float maxFlake = 0.0;
      for (int index = 0; index < 4; index += 1) {
        bool directional = uLightDirectional[index] > .5;
        vec3 delta = directional ? normalize(uLightPosition[index] - uLightTarget[index]) : uLightPosition[index] - vWorld; float distanceSquared = max(dot(delta, delta), .001), distanceValue = sqrt(distanceSquared), cone = 1.0;
        if (!directional && uLightSpot[index] > .5) {
          vec3 axis = uLightTarget[index] - uLightPosition[index];
          float targetDistance = max(length(axis), .001);
          axis /= targetDistance;
          vec3 fromLight = vWorld - uLightPosition[index];
          float axialDistance = dot(fromLight, axis);
          float heightRatio = clamp(axialDistance / targetDistance, .08, 1.35);
          float surfaceRadius = mix(uLightRadius[index], uLightRadius[index] * heightRatio, uLightCone[index]);
          vec3 radialOffset = fromLight - axis * axialDistance;
          if (uIsFloor > .5) radialOffset.z /= max(uLightFloorAspect[index], 1.0);
          float radial = axialDistance > 0.0 ? length(radialOffset) / max(surfaceRadius, .1) : 2.0;
          cone = 1.0 - smoothstep(.18, 1.18, radial);
        }
        float diffuseDot=max(dot(normal,delta/distanceValue),0.0);
        float diffuse=uCanvasPalette>.5 ? diffuseDot : .14+.86*diffuseDot;
        float falloff=uCanvasPalette>.5 ? .075 : uLightDecay[index];
        float amount=uLightPower[index]*cone*diffuse/(1.0+distanceSquared*falloff*(directional?0.0:1.0));
        direct += amount; lightTint += amount * uLightColour[index];        if (hasFlake && uLightPower[index] > 0.0) {
          vec3 halfVector = normalize(delta / distanceValue + viewDirection);
          float flakeSpec = pow(max(dot(microNormal, halfVector), 0.0), 28.0);
          float attenuation = 1.0 / (1.0 + distanceSquared * uLightDecay[index] * (directional ? 0.0 : 1.0));
          maxFlake = max(maxFlake, flakeSpec * uLightPower[index] * cone * attenuation);
        }
      }
      if (uRenderMode > 2.5 && uIsFloor < .5) { vec3 edge=smoothstep(vec3(0.0),fwidth(vBarycentric)*1.25,vBarycentric); float line=1.0-min(edge.x,min(edge.y,edge.z)); outColour=vec4(mix(vec3(.055,.07,.09),vec3(.35,.9,1.0),line),1.0); return; }
      float visibility = shadowVisibility(), luminance = clamp(uAmbient + direct * visibility, .04, 1.18), cells = max(4.0, uPixelDensity), noise = 0.0;
      if (uIsFloor < .5 && uDither > .5 && uRenderMode < 1.5) {
        float bandPosition = luminance * uBands;
        float transitionWeight = 1.0 - smoothstep(.0, .35, min(fract(bandPosition), 1.0 - fract(bandPosition)));
        float darkWeight = 1.0 - smoothstep(.45, .75, luminance);
        noise = bodyDither(gl_FragCoord.xy) * transitionWeight * darkWeight / max(2.0, uBands);
      }
      if (uRenderMode < 1.5) luminance = floor(clamp(luminance + noise, 0.0, 1.16) * uBands) / max(1.0, uBands - 1.0);
      vec3 tint = direct > .001 ? lightTint / direct : vec3(1.0); float tintLuminance = max(.18, dot(tint, vec3(.2126, .7152, .0722))), colourAmount = uColoured * smoothstep(.015, .72, direct); vec3 energyTint = clamp(tint / tintLuminance, .48, 1.72); vec3 body = surfaceBase * (.18 + luminance * .82); body *= mix(vec3(1.0), energyTint, colourAmount * .58); body += surfaceBase * uEmissive;
      if(uCanvasPalette>.5 && uIsFloor<.5) {
        float tone=1.0-exp(-max(0.0,uAmbient+direct*visibility)*1.22);
        if(uRenderMode<1.5) {
          float scaled=tone*max(1.0,uBands-1.0);
          if(uDither>.5 && uRenderMode<.5) {
            float distanceFromSeam=abs(fract(scaled)-.5);
            float ditherWeight=clamp(1.0-distanceFromSeam/.14,0.0,1.0);
            float bayerRank=(bodyDither(gl_FragCoord.xy)+.5)*16.0-.5;
            scaled+=(bayerRank/15.0-.5)*ditherWeight;
          }
          tone=clamp(floor(scaled+.5)/max(1.0,uBands-1.0),0.0,1.0);
        }
        // Match the CPU palette lookup's 256 discrete entries.
        tone=floor(tone*255.0+.5)/255.0;
        float gradientPosition=clamp((uGradient<0.0?-vLocal.y:vLocal.y)*.5+.5,0.0,1.0);
        body=mix(studioPalette(uBase,tone),studioPalette(complementary,tone),abs(uGradient)*gradientPosition);
        if(uPreserveColour>.5){
          float panel=uHatPanel.w*step(.12,vLocal.z)*(1.0-step(.90,abs(vLocal.x)))*(1.0-step(.84-.22*vLocal.x*vLocal.x,(vLocal.y+1.0)*.5));
          vec3 material=mix(uBase,uHatPanel.rgb,panel);
          if(uSkull.z>0.0)material=maskBase;
          if(uHatBand.w>-1.0 && vLocal.y<uHatBand.w)material=uHatBand.rgb;
          body=material*mix(.25,1.34,tone);
        }
        if(uColoured>.5 && uPaletteGrayscale<.5) body*=clamp(pow(max(tint/ max(.001,dot(tint,vec3(.2126,.7152,.0722))),vec3(0.0)),vec3(.34)),.68,1.32);
        body+=surfaceBase*uEmissive;
      }

      if (uIsFloor > .5) {
        vec2 gridDistance = abs(fract(vWorld.xz + .5) - .5) / fwidth(vWorld.xz); float grid = 1.0 - min(min(gridDistance.x, gridDistance.y), 1.0);
        vec3 floorColour = mix(uFloorBase, uFloorHighlight, grid * .34); floorColour *= mix(vec3(1.0), energyTint, colourAmount * .46); outColour = vec4(vec3(0.0), 1.0 - visibility); return;
      }
      if(uKnit>.5 && uIsFloor<.5){
        float rib=.5+.5*cos(atan(vLocal.x,vLocal.z)*40.0);
        body*=mix(.86,1.04,rib*rib);
      }
      if(uStripes>.5 && uIsFloor<.5) {
        float stripe=1.0-step(1.0,mod(floor((glitterPosition.y+100.0)/.16),2.0));
        body=mix(body,mix(body,vec3(1.0),.30),stripe);
      }
      if (uGlossy > .001 && uIsFloor < .5) {
        vec3 view=normalize(uCameraPosition-vWorld);
        float ndotv=clamp(dot(normal,view),0.0,1.0);
        vec3 reflection=normalize(2.0*ndotv*normal-view);
        vec3 env=sampleProceduralEnv(reflection,1.0-uGlossy);
        float metallic=uPreserveColour>1.5 ? 0.0 : clamp(uGlossy*1.25-.25,0.0,1.0);
        vec3 reflected=mix(env,env*body*1.35,metallic);
        if(uPaletteGrayscale>.5)reflected=vec3(dot(reflected,vec3(.2126,.7152,.0722)));
        float f0=mix(.04,.95,metallic);
        float fresnel=f0+(1.0-f0)*pow(1.0-ndotv,5.0);
        if(uPreserveColour>1.5) {
          // Keep the Canvas tint; only the bright studio reflections affect the lens.
          vec3 highlight=max(env-vec3(.72),vec3(0.0))/ .28;
          body=mix(body,vec3(1.0),clamp(max(highlight.r,max(highlight.g,highlight.b))*uGlossy*.65,0.0,.65));
        } else body=body*max(0.0,1.0-metallic*.95)+reflected*uGlossy*mix(.55,1.0,fresnel);
      }
      if (hasFlake) {
        float twinkle = .5 + .5 * sin(uTime * 4.8 + flakePhase + glitterPosition.x * 9.0 + glitterPosition.y * 9.0);
        vec3 prism = vec3(1.0) + .35 * sin(vec3(flakePhase, flakePhase + 2.09, flakePhase + 4.18));
        body += maxFlake * (twinkle * 3.3 + .45) * uGlitter * (260.0 / 255.0) * visibility * prism;
      }
      if (uFaceEnabled > .5) {
        float front = smoothstep(.32, .64, vLocal.z), density = max(10.0, cells * 1.02), eyeTilt = uFaceStyle.y * .055, eyeSpacingFactor = mix(.7, 1.0, smoothstep(1.0/1.4, 1.0, uFaceVariation.y)), eyeSpacing = .276 * uFaceVariation.x * uFaceSpread.x * eyeSpacingFactor; // All facial features use the same fitted coordinates and retain their spacing.
        vec2 point = vLocal.xy / uFaceLayout.xy + uFaceLayout.zw;
        vec2 leftEyePoint = point - vec2(-eyeSpacing, .17 * uFaceSpread.y - eyeTilt), rightEyePoint = point - vec2(eyeSpacing, .17 * uFaceSpread.y + eyeTilt), eyeRadiiL = vec2(1.0, clamp(uEyeOpen.x, .05, 1.0)) * (.20475 * uFaceVariation.y), eyeRadiiR = vec2(1.0, clamp(uEyeOpen.y, .05, 1.0)) * (.20475 * uFaceVariation.y);
        float smileAll = smoothstep(.82, .98, uFaceStyle.x), smileLeftAmount = max(smileAll, (1.0 - smoothstep(.22, .42, uEyeOpen.x)) * smoothstep(.05, .4, uFaceStyle.x + .12)), smileRightAmount = max(smileAll, (1.0 - smoothstep(.22, .42, uEyeOpen.y)) * smoothstep(.05, .4, uFaceStyle.x + .12));
        float leftEye = (1.0 - faceEdge(-.015, .015, ellipseSdf(leftEyePoint, eyeRadiiL))) * (1.0 - smileLeftAmount) * (1.0 - uEyeCross), rightEye = (1.0 - faceEdge(-.015, .015, ellipseSdf(rightEyePoint, eyeRadiiR))) * (1.0 - smileRightAmount) * (1.0 - uEyeCross), eyes = max(leftEye, rightEye) * front * (1.0-smoothstep(.65, .95, uBlinkClosure));
        body = mix(body, vec3(.96, .975, 1.0), eyes);
        vec2 pupilOffset = vec2(uGaze.x * .095, uGaze.y * .032) * uFaceVariation.z, pupilLPoint = leftEyePoint - pupilOffset, pupilRPoint = rightEyePoint - pupilOffset;
        float pupils = max((1.0 - faceEdge(-.01, .012, ellipseSdf(pupilLPoint, vec2(.1092, .1092) * uFaceVariation.z))) * leftEye, (1.0 - faceEdge(-.01, .012, ellipseSdf(pupilRPoint, vec2(.1092, .1092) * uFaceVariation.z))) * rightEye) * front;
        vec2 leftEyeCenter = vec2(-eyeSpacing, .17 * uFaceSpread.y - eyeTilt), rightEyeCenter = vec2(eyeSpacing, .17 * uFaceSpread.y + eyeTilt); float crossArm = .095;
        float leftCross = max(1.0 - faceEdge(.024, .058, lineSdf(point, leftEyeCenter - vec2(crossArm, crossArm), leftEyeCenter + vec2(crossArm, crossArm))), 1.0 - faceEdge(.024, .058, lineSdf(point, leftEyeCenter - vec2(crossArm, -crossArm), leftEyeCenter + vec2(crossArm, -crossArm))));
        float rightCross = max(1.0 - faceEdge(.024, .058, lineSdf(point, rightEyeCenter - vec2(crossArm, crossArm), rightEyeCenter + vec2(crossArm, crossArm))), 1.0 - faceEdge(.024, .058, lineSdf(point, rightEyeCenter - vec2(crossArm, -crossArm), rightEyeCenter + vec2(crossArm, -crossArm))));
        float crosses = max(leftCross, rightCross) * front * uEyeCross;
        vec2 smileEyePoint = point - vec2(0.0, .17 * (uFaceSpread.y - 1.0));
        smileEyePoint.y = mix(smileEyePoint.y, .28 - smileEyePoint.y, uExpressionDetails.x);
        float smileLeft = max(1.0 - faceEdge(.018, .04, lineSdf(smileEyePoint, vec2(-eyeSpacing - .1, .14), vec2(-eyeSpacing, .2))), 1.0 - faceEdge(.018, .04, lineSdf(smileEyePoint, vec2(-eyeSpacing, .2), vec2(-eyeSpacing + .1, .14)))) * smileLeftAmount;
        float smileRight = max(1.0 - faceEdge(.018, .04, lineSdf(smileEyePoint, vec2(eyeSpacing - .1, .14), vec2(eyeSpacing, .2))), 1.0 - faceEdge(.018, .04, lineSdf(smileEyePoint, vec2(eyeSpacing, .2), vec2(eyeSpacing + .1, .14)))) * smileRightAmount;
        // Joy eyes: enlarged smooth inverted-U arches instead of chevrons.
        vec2 joyLeft = point - vec2(-eyeSpacing, .14 + .17 * (uFaceSpread.y - 1.0));
        vec2 joyRight = point - vec2(eyeSpacing, .14 + .17 * (uFaceSpread.y - 1.0));
        joyLeft.y *= 1.0 - 2.0 * uExpressionDetails.x;
        joyRight.y *= 1.0 - 2.0 * uExpressionDetails.x;
        float joyRadius = .13;
        float joyDistanceL = joyLeft.y >= 0.0 ? abs(length(joyLeft) - joyRadius) : length(vec2(abs(joyLeft.x) - joyRadius, joyLeft.y));
        float joyDistanceR = joyRight.y >= 0.0 ? abs(length(joyRight) - joyRadius) : length(vec2(abs(joyRight.x) - joyRadius, joyRight.y));
        // Morph the signed-distance shapes instead of cross-fading two eye drawings.
        float arcBlink=uBlinkClosure*uBlinkClosure*(3.0-2.0*uBlinkClosure);
        vec2 blinkArcL=point-vec2(-eyeSpacing,.14+.17*(uFaceSpread.y-1.0));
        vec2 blinkArcR=point-vec2(eyeSpacing,.14+.17*(uFaceSpread.y-1.0));
        float blinkDistanceL=max(abs(blinkArcL.y-(.03*pow(blinkArcL.x/.184,2.0)-.03)),abs(blinkArcL.x)-.184+.0336);
        float blinkDistanceR=max(abs(blinkArcR.y-(.03*pow(blinkArcR.x/.184,2.0)-.03)),abs(blinkArcR.x)-.184+.0336);
        joyDistanceL=mix(joyDistanceL,blinkDistanceL,arcBlink);
        joyDistanceR=mix(joyDistanceR,blinkDistanceR,arcBlink);
        float joyEyeL = 1.0 - faceEdge(.0252, .042, joyDistanceL);
        float joyEyeR = 1.0 - faceEdge(.0252, .042, joyDistanceR);
        smileLeft = mix(smileLeft, joyEyeL * smileLeftAmount, uJoyEyes);
        smileRight = mix(smileRight, joyEyeR * smileRightAmount, uJoyEyes);
        vec2 mouthPoint = vec2(point.x, point.y + .2 * (uFaceSpread.y - 1.0) - uFaceStyle.z * point.x * .12); float mouthOpen = uMouth.y, mouth, mouthScale = uFaceVariation.w;
        float mouthAnimation = uSmileOpen > .5 ? uMouthReaction : 1.0;
        float mouthPulse = 1.0 + .20 * mouthAnimation * sin(uTime * 15.0 * uExpressionDetails.z + uFaceVariation.w * 11.0);
        if (mouthOpen > .18 || uMouth.w > .55) {
          mouthPoint.x *= sqrt(mouthPulse);
          mouthPoint.y = -.2 + (mouthPoint.y + .2) / (1.44 * mouthPulse);
        }
        if (uMouth.w > .55) mouth = 1.0 - faceEdge(-.015, .018, ellipseSdf(mouthPoint - vec2(0.0, -.2), vec2(.07 + .035 * (1.0 - uMouth.w), .055 + mouthOpen * .07)));
        else if (mouthOpen > .18 && uSmileOpen <= 0.0) mouth = 1.0 - faceEdge(-.015, .018, ellipseSdf(mouthPoint - vec2(0.0, -.2), vec2(.14 * uMouth.z * mouthScale, .035 + mouthOpen * .08)));
        else { mouthPoint = vec2(mouthPoint.x / 1.3, -.2 + (mouthPoint.y + .2) / 1.3); float curveY = -.2 + uMouth.x * (mouthPoint.x * mouthPoint.x - .018) * 1.8; mouth = (1.0 - faceEdge(.018, .04, abs(mouthPoint.y - curveY))) * (1.0 - faceEdge(.14 * uMouth.z * mouthScale, .18 * uMouth.z * mouthScale, abs(mouthPoint.x))); }
        float browY = .432 * uFaceSpread.y + .20475 * (uFaceVariation.y - 1.0) + uBrow.x * .12, browAsym = uFaceStyle.w * .055;
        float browThickness = uBrowThickness > 0.0 ? uBrowThickness : mix(1.0, 1.7, clamp((uFaceVariation.w - .94) / .12, 0.0, 1.0));
        vec2 browPoint = vec2(point.x / (1.3 * uFaceSpread.x), point.y);
        browPoint.x += sign(browPoint.x) * .24 * (1.0 - uBrowSpacing * eyeSpacingFactor);
        float happyBrow = max(smoothstep(.4, .85, uMouth.x), smoothstep(.4, .9, uFaceStyle.x));
        float browLocalX = clamp((abs(browPoint.x) - .24) / .11, -1.0, 1.0);
        float browArch = .0585 * uExpressionDetails.y;
        float browSlope = -2.0 * browArch * browLocalX / .11;
        float browStrokeScale = sqrt(1.0 + browSlope * browSlope);
        browPoint.y -= browArch * (1.0 - browLocalX * browLocalX);
        float browLeft = 1.0 - faceEdge(.018 * browThickness * browStrokeScale, .035 * browThickness * browStrokeScale, lineSdf(browPoint, vec2(-.35, browY + browAsym), vec2(-.13, browY + browAsym - uBrow.y * .08)));
        float browRight = 1.0 - faceEdge(.018 * browThickness * browStrokeScale, .035 * browThickness * browStrokeScale, lineSdf(browPoint, vec2(.13, browY - browAsym - uBrow.y * .08), vec2(.35, browY - browAsym)));
        // A D-shaped open smile: flat upper edge and a rounded lower bowl.
        vec2 smilePoint = vec2(mouthPoint.x, mouthPoint.y + .2) / 1.5 + vec2(0.0, -.05);
        vec2 smileRadii = vec2(.19 * uMouth.z * mouthScale, .16);
        float smileDistance = max((length(smilePoint / smileRadii) - 1.0) * min(smileRadii.x, smileRadii.y), smilePoint.y);        float closedCurveY = -.2 + uMouth.x * (pow(mouthPoint.x / 1.3, 2.0) - .018) * 1.8 * 1.3;
        float closedSmileDistance = max(abs(mouthPoint.y - closedCurveY) - .025, abs(mouthPoint.x) - .20 * uMouth.z * mouthScale) / 1.5;
        smileDistance = mix(closedSmileDistance, smileDistance, uSmileOpen);
        float smileOuter = 1.0 - faceEdge(-.004, .004, smileDistance);
        float smileInner = 1.0 - faceEdge(-.004, .004, smileDistance + .02156);
        if (uSmileOpen > 0.0) mouth = smileOuter;
        if(uMouthWave>.5) {
          vec2 wavePoint=point-vec2(0.0,-.2-.2*(uFaceSpread.y-1.0));
          float halfWidth=.66*uMouth.z*mouthScale;
          float waveY=.045*sin(wavePoint.x/halfWidth*6.283185);
          float waveSlope=.045*6.283185/halfWidth*cos(wavePoint.x/halfWidth*6.283185);
          float waveDistance=abs(wavePoint.y-waveY)/sqrt(1.0+waveSlope*waveSlope);
          mouth=(1.0-step(.0377,waveDistance))*(1.0-step(halfWidth,abs(wavePoint.x)));
        }
        float closedAmount=smoothstep(.65,.95,uBlinkClosure);
        vec2 closedL=point-vec2(-eyeSpacing,.14+.17*(uFaceSpread.y-1.0));
        vec2 closedR=point-vec2(eyeSpacing,.14+.17*(uFaceSpread.y-1.0));
        float closedLeft=(1.0-step(.0336,abs(closedL.y-(.03*pow(closedL.x/.184,2.0)-.03))))*(1.0-step(.184,abs(closedL.x)));
        float closedRight=(1.0-step(.0336,abs(closedR.y-(.03*pow(closedR.x/.184,2.0)-.03))))*(1.0-step(.184,abs(closedR.x)));
        if(uWinkBlink>.5)smileLeft=closedLeft;
        pupils*=1.0-closedAmount;crosses*=1.0-closedAmount;
        smileLeft=mix(smileLeft,closedLeft,closedAmount*(1.0-uJoyEyes));
        smileRight=mix(smileRight,closedRight,closedAmount*(1.0-uJoyEyes));
        float ink = max(max(max(max(pupils, crosses), max(smileLeft, smileRight) * front), mouth * front), max(browLeft, browRight) * front); body = mix(body, vec3(.018, .022, .03), ink);
        body = mix(body, vec3(.85), smileInner * step(.0001, uSmileOpen) * front);
      }
      if(uMaskStrap.y>0.0 && abs(vLocal.y-uMaskStrap.x)<uMaskStrap.y && (abs(vLocal.x)>uMaskStrap.z || vLocal.z<0.0))body=vec3(.086275,.078431,.098039);
      outColour = vec4(clamp(body, 0.0, 1.0), uOpacity);
    }`;

  const SHADOW_VERTEX = `#version 300 es
    precision highp float;
    layout(location=0) in vec3 aPosition;
    uniform mat4 uModel;
    uniform mat4 uLightViewProjection;
    void main() { gl_Position = uLightViewProjection * uModel * vec4(aPosition, 1.0); }`;
  const SHADOW_FRAGMENT = `#version 300 es
    precision highp float;
    void main() { }`;

  const SURFACE_VERTEX = `#version 300 es
    precision highp float;
    layout(location=0) in vec3 aPosition;
    uniform mat4 uModel;
    uniform mat4 uViewProjection;
    uniform float uTime;
    uniform float uGhost;
    uniform vec2 uClothMotion;
    ${GHOST_DEFORMATION}
    void main(){gl_Position=uViewProjection*uModel*vec4(deformGhost(aPosition,uTime,uGhost,uClothMotion),1.0);}`;
  const SURFACE_FRAGMENT = `#version 300 es
    precision highp float;
    uniform vec4 uSurface;
    out vec4 colour;
    void main(){colour=uSurface;}`;
  const EDGE_VERTEX = `#version 300 es
    void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0.0,1.0);}`;
  const EDGE_FRAGMENT = `#version 300 es
    precision highp float;
    precision highp int;
    uniform sampler2D uSurfaces;
    uniform int uRadius;
    out vec4 colour;
    vec4 surfaceAt(ivec2 p){ivec2 size=textureSize(uSurfaces,0);if(any(lessThan(p,ivec2(0)))||any(greaterThanEqual(p,size)))return vec4(0.0);return texelFetch(uSurfaces,p,0);}
    bool boundary(vec4 a,vec4 b){if(a.b>2.5/255.0 || b.b>2.5/255.0)return false;return abs(a.a-b.a)>.5 || (a.a>.5 && b.a>.5 && any(greaterThan(abs(a.rgb-b.rgb),vec3(.5/255.0))));}
    void main(){
      ivec2 p=ivec2(gl_FragCoord.xy);vec4 center=surfaceAt(p);bool edge=false;
      for(int r=1;r<=4;r++){if(r>uRadius)break;
        edge=edge||boundary(center,surfaceAt(p+ivec2(r,0)))||boundary(center,surfaceAt(p-ivec2(r,0)))||boundary(center,surfaceAt(p+ivec2(0,r)))||boundary(center,surfaceAt(p-ivec2(0,r)));
      }
      if(!edge)discard;
      colour=vec4(.018,.022,.03,1.0);
    }`;

  export class CrowdGLRenderer {
    constructor() {
      this.canvas = document.createElement('canvas'); this.gl = this.canvas.getContext('webgl2', { alpha: true, antialias: false, depth: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' }); this.available = Boolean(this.gl); this.meshes = new Map(); this.expressionStates = new WeakMap();
      if (!this.available) return;
      const gl = this.gl; this.program = this.createProgram(BODY_VERTEX, BODY_FRAGMENT); this.shadowProgram = this.createProgram(SHADOW_VERTEX, SHADOW_FRAGMENT); this.uniforms = this.getUniforms(this.program, ['uClothMotion','uModel','uViewProjection','uLightViewProjection','uNormalMatrix','uOutlineViewport','uOutlinePerspective','uOutline','uOpacity','uGlossy','uStripes','uKnit','uPreserveColour','uSkull','uMaskStrap','uSkullTexture','uHatPanel','uHatBand','uEmissive','uGradient','uGradientComplement','uHasGradientComplement','uBrowThickness','uGlitter','uGlitterDimensions','uTime','uMouthReaction','uExpressionDetails','uBrowSpacing','uBlinkClosure','uWinkBlink','uCameraPosition','uBase','uLightPosition','uLightDecay','uLightDirectional','uLightTarget','uLightColour','uLightPower','uLightRadius','uLightSpot','uLightCone','uLightFloorAspect','uFloorGlow','uFloorBase','uFloorHighlight','uAmbient','uBands','uPixelDensity','uDither','uRenderMode','uColoured','uCanvasPalette','uPaletteGrayscale','uDisco','uFaceEnabled','uEyeCross','uIsFloor','uEyeOpen','uGaze','uMouth','uSmileOpen','uMouthWave','uJoyEyes','uBrow','uFaceStyle','uFaceVariation','uFaceAspect','uFaceLayout','uFaceSpread','uShadowMap','uHasShadow']); this.shadowUniforms = this.getUniforms(this.shadowProgram, ['uModel','uLightViewProjection']);
      this.floorMesh = this.uploadMesh({ positions: new Float32Array([-.5,0,-.5,.5,0,-.5,.5,0,.5,-.5,0,.5]), indices: new Uint16Array([0,2,1,0,3,2]), normals: new Float32Array([0,1,0,0,1,0,0,1,0,0,1,0]) }); this.createShadowTarget();
      gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CCW);
    }

    createShader(type, source) { const gl = this.gl, shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)); return shader; }
    createProgram(vertexSource, fragmentSource) { const gl = this.gl, program = gl.createProgram(); gl.attachShader(program, this.createShader(gl.VERTEX_SHADER, vertexSource)); gl.attachShader(program, this.createShader(gl.FRAGMENT_SHADER, fragmentSource)); gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)); return program; }
    getUniforms(program, names) { const gl = this.gl, result = {}; names.forEach((name) => { result[name] = gl.getUniformLocation(program, name); }); return result; }

    uploadMesh(source) {
      const gl = this.gl, normals = source.normals || accumulateNormals(source.positions, source.indices), vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const positionBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer); gl.bufferData(gl.ARRAY_BUFFER, source.positions, gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      const normalBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer); gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      const indexBuffer = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, source.indices, gl.STATIC_DRAW); gl.bindVertexArray(null); return { vao, count: source.indices.length, source: {positions:source.positions,indices:source.indices,normals} };
    }

    meshFor(member) {
      if(member.body.shape==='ghostSheet'){const key='ghost|'+JSON.stringify(member.body);if(!this.meshes.has(key))this.meshes.set(key,this.uploadMesh(ghostSheet(member.body)));return this.meshes.get(key);}
      const shape = member.body.shape, exponent = shape === 'sphere' ? 1 : (shape === 'cube' || shape === 'roundedBox') ? (.10 + ((shape === 'cube' ? .15 : .4) - .10) / .42 * .58) : 0, key = shape === 'capsule' ? `capsule|${member.body.width}|${member.body.height}|${member.body.depth}` : `${shape}|${exponent.toFixed(2)}|${member.body.lowPoly ? 'low' : 'normal'}`;
      if (!this.meshes.has(key)) this.meshes.set(key, this.uploadMesh(shape === 'antlerLeft' ? reindeerAntler(-1) : shape === 'antlerRight' ? reindeerAntler(1) : shape === 'elfCrown' ? elfCrown() : shape === 'santaCrown' ? santaCrown() : shape === 'devilHornLeft' ? devilHorn(-1) : shape === 'devilHornRight' ? devilHorn(1) : (shape === 'lensBridge' || shape === 'skullMask') ? {positions:new Float32Array([-.5,-.5,0,.5,-.5,0,.5,.5,0,-.5,.5,0]),indices:new Uint16Array([0,1,2,0,2,3])} : shape === 'squareLensDisc' ? flatLens(false,true) : shape === 'squareLensRing' ? flatLens(true,true) : shape === 'lensDisc' ? flatLens() : shape === 'lensRing' ? flatLens(true) : shape === 'capsule' ? capsule(member.body) : shape === 'hemisphere' ? hemisphere() : shape === 'capVisor' ? capVisor() : shape === 'bowlerCrown' ? bowlerCrown() : shape === 'bowlerBrim' ? bowlerBrim() : member.body.lowPoly ? superellipsoid(1,11,10) : superellipsoid(exponent)));
      return this.meshes.get(key);
    }

    createShadowTarget() {
      const gl = this.gl; this.shadowSize = 1024; this.shadowFramebuffer = gl.createFramebuffer(); this.shadowTexture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, this.shadowSize, this.shadowSize, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFramebuffer); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTexture, 0); gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    resize(width, height) { if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; } }
    expression(member, time) {
      const catalog = EXPRESSIONS, neutral = catalog.neutral || {}, resolve = (value, fallback) => value && typeof value === 'object' ? value : catalog[value] || fallback, from = resolve(member.expressionFrom || member.faceExpression || member.expression, neutral), to = resolve(member.expressionTo, from), progress = clamp(member.expressionProgress ?? 0, 0, 1), source = {};
      Object.assign(source, progress >= .5 ? to : from);
      const cycle = (time * .72 + member.phase) % 3.6, blink = typeof member.gazeBlink === 'number' ? member.gazeBlink : (cycle < .075 ? Math.sin(cycle / .075 * Math.PI) : 0);
      let state = this.expressionStates.get(member);
      if (!state || time < state.lastTime) {
        state = { current: { ...source }, lastBlink: time - 1, started: null, lastTime: time };
        this.expressionStates.set(member, state);
      }
      const browKeys=['browLift','browTilt','browAsym','browArch','browSpacing'];
      const desiredBrows=browKeys.map(key=>source[key] ?? (key==='browSpacing'?1:0));
      if(!state.brows)state.brows={value:[...desiredBrows],from:[...desiredBrows],target:[...desiredBrows],started:time};
      const brows=state.brows;
      const t=clamp((time-brows.started)/.12,0,1), ease=t*t*(3-2*t);
      brows.value=brows.from.map((value,index)=>value+(brows.target[index]-value)*ease);
      if(desiredBrows.some((value,index)=>Math.abs(value-brows.target[index])>1e-6)){
        brows.from=[...brows.value];brows.target=[...desiredBrows];brows.started=time;
      }
      state.lastTime = time;
      const changed = Object.keys(source).some((key) => Math.abs((source[key] || 0) - (state.current[key] || 0)) > .18);
      const closedEyes=value=>(value.blinkEyes || 0)>.5 || (value.eyeCross || 0)>.5 || (value.joyEyes || 0)>.5 || ((value.leftEyeOpen ?? 1)<=.2 && (value.rightEyeOpen ?? 1)<=.2);
      if(changed && closedEyes(state.current) && closedEyes(source)) {
        state.current={...source};state.started=null;state.pending=null;
      } else if (changed && state.started === null && time - state.lastBlink >= .7) { state.started = time; state.pending = { ...source }; }
      let expressionBlink = 0;
      if (state.started !== null) {
        const elapsed = time - state.started;
        expressionBlink = Math.sin(Math.min(1, elapsed / .14) * Math.PI);
        if (elapsed >= .07) state.current = { ...state.pending };
        if (elapsed >= .14) { state.started = null; state.lastBlink = time; }
      }
      if (blink > .9 && state.started === null) { state.current = { ...source }; state.lastBlink = time; }
      for (const key of Object.keys(source)) delete source[key];
      Object.assign(source, state.current);
      browKeys.forEach((key,index)=>{source[key]=brows.value[index];});
      const coordinatedBlink = source.blinkEyes>.5 ? 1 : closedEyes(source) ? 0 : Math.max(blink, expressionBlink);
      return { winkBlink: source.winkBlink || 0, blinkClosure: coordinatedBlink, eye: [clamp((source.leftEyeOpen ?? 1) * (1 - coordinatedBlink), .05, 1.3), clamp((source.rightEyeOpen ?? 1) * (1 - coordinatedBlink), .05, 1.3)], browSpacing: source.browSpacing ?? 1, details: [source.eyeConcave || 0, source.browArch || 0, source.mouthSpeed ?? 1], mouthReaction: clamp(member.mouthReaction ?? 0, 0, 1), joyEyes: source.joyEyes ?? 0, mouthWave: source.mouthWave || 0, smileOpen: source.mouthSmileOpen ?? 0, mouth: [source.mouthCurve ?? .12, source.mouthOpen ?? 0, source.mouthWidth ?? .74, source.mouthRound ?? 0], brow: [source.browLift ?? 0, source.browTilt ?? 0, source.browAsym ?? 0], style: [source.eyeSmile ?? 0, source.eyeTilt ?? 0, source.mouthTilt ?? 0, source.browAsym ?? 0], variation: member.faceStyle || [1,1,1,1], cross: clamp(source.eyeCross ?? 0, 0, 1) };
    }

    setCommonUniforms(scene, viewProjection, lightViewProjection, hasShadow) {
      const gl = this.gl, u = this.uniforms, positions = new Float32Array(12), targets = new Float32Array(12), colours = new Float32Array(12), powers = new Float32Array(4), decays = new Float32Array(4), directionals = new Float32Array(4), radii = new Float32Array(4), spots = new Float32Array(4), cones = new Float32Array(4), floorAspects = new Float32Array([1, 1, 1, 1]);
      for (let index = 0; index < 4; index += 1) { const light = scene.lights[index], offset = index * 3; if (light) { positions.set([light.x, light.y, light.z], offset); targets.set(light.target ? [light.target.x, light.target.y, light.target.z] : [light.x, 0, light.z], offset); colours.set(hexToRgb(light.color), offset); powers[index] = light.enabled ? light.intensity : 0; radii[index] = light.coneRadius || 4; spots[index] = light.spotlight ? 1 : 0; decays[index] = light.distanceDecay ?? (light.spotlight ? .045 : .08); directionals[index] = light.directional ? 1 : 0; cones[index] = light.volumetric ? 1 : 0; floorAspects[index] = light.floorAspect || 1; } }
      const renderMode = scene.mode === 'toon' ? 1 : scene.mode === 'smooth' ? 2 : scene.mode === 'mesh' ? 3 : 0;
      this.meshView=scene.mode==='mesh';
      gl.uniform1f(u.uTime, scene.time || 0); gl.uniform3fv(u.uCameraPosition, [scene.camera.position.x, scene.camera.position.y, scene.camera.position.z]); gl.uniformMatrix4fv(u.uViewProjection, false, viewProjection); gl.uniformMatrix4fv(u.uLightViewProjection, false, lightViewProjection); gl.uniform3fv(u.uLightPosition, positions); gl.uniform3fv(u.uLightTarget, targets); gl.uniform3fv(u.uLightColour, colours); gl.uniform1fv(u.uLightPower, powers); gl.uniform1fv(u.uLightDecay, decays); gl.uniform1fv(u.uLightDirectional, directionals); gl.uniform1fv(u.uLightRadius, radii); gl.uniform1fv(u.uLightSpot, spots); gl.uniform1fv(u.uLightCone, cones); gl.uniform1fv(u.uLightFloorAspect, floorAspects); gl.uniform1f(u.uFloorGlow, scene.floorGlow ?? .13); gl.uniform3fv(u.uFloorBase, hexToRgb(scene.floorBase || '#0b0d11')); gl.uniform3fv(u.uFloorHighlight, hexToRgb(scene.floorHighlight || '#212630')); gl.uniform1f(u.uAmbient, scene.ambient); gl.uniform1f(u.uBands, scene.bands); gl.uniform1f(u.uPixelDensity, scene.pixelDensity); gl.uniform1f(u.uDither, scene.dither ? .7 : 0); gl.uniform1f(u.uRenderMode, renderMode); gl.uniform1f(u.uColoured, scene.coloured ? 1 : 0); gl.uniform1f(u.uCanvasPalette, scene.paletteMode === 'canvas' ? 1 : 0); gl.uniform1f(u.uPaletteGrayscale, scene.grayscale ? 1 : 0); gl.uniform1f(u.uDisco, scene.disco ? 1 : 0); gl.uniform1f(u.uHasShadow, hasShadow ? 1 : 0); gl.uniform1i(u.uShadowMap, 0);
    }

    drawMesh(mesh, model, normal, base, outline, face, expression, gaze, isFloor = false, emissive = 0, gradient = false, glitter = 0, browThickness = 0, gradientComplement = null, opacity = 1, glossy = 0, glitterDimensions = [1,1,1], stripes = false, knit = false, preserveColour = false, hatPanel = null, hatBand = null, skull = null, maskStrap = null) {
      const gl = this.gl, u = this.uniforms; gl.uniform4fv(u.uSkull,skull || [0,0,0,0]);gl.uniform3fv(u.uMaskStrap,maskStrap || [0,0,0]);
      if(skull && skull[3]<2.5){
        gl.activeTexture(gl.TEXTURE3);
        this.maskTextures ||= new Map();
        const maskKind=skull[3]>1.5?'pumpkin':'skull',strokeWidth=skull[0] || 12,maskKey=maskKind+'|'+strokeWidth;
        this.readyMaskTextures ||= new Map();
        let entry=this.maskTextures.get(maskKey);
        if(!entry){
          const texture=gl.createTexture();entry={texture,ready:false};this.maskTextures.set(maskKey,entry);gl.bindTexture(gl.TEXTURE_2D,texture);
          gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,0]));
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
          const image=new Image();image.onload=()=>{
            gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
            entry.ready=true;this.readyMaskTextures.set(maskKind,texture);gl.activeTexture(gl.TEXTURE0);
          };
          image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent((maskKind==='pumpkin'?PUMPKIN_SVG:SKULL_SVG).replaceAll('stroke-width="12"','stroke-width="'+strokeWidth+'"'));
        }
        // Keep the last completed version visible while a new stroke size loads.
        const texture=entry.ready?entry.texture:this.readyMaskTextures.get(maskKind);
        if(!texture){gl.activeTexture(gl.TEXTURE0);return;}
        gl.bindTexture(gl.TEXTURE_2D,texture);gl.uniform1i(u.uSkullTexture,3);gl.activeTexture(gl.TEXTURE0);
      } gl.uniformMatrix4fv(u.uModel, false, model); gl.uniformMatrix3fv(u.uNormalMatrix, false, normal); gl.uniform3fv(u.uBase, base); gl.uniform1f(u.uHasGradientComplement, gradientComplement ? 1 : 0); gl.uniform3fv(u.uGradientComplement, gradientComplement ? hexToRgb(gradientComplement) : base); gl.uniform1f(u.uGradient, typeof gradient === 'number' ? gradient : gradient ? 1 : 0); gl.uniform1f(u.uGlitter, glitter); gl.uniform3fv(u.uGlitterDimensions, glitterDimensions); gl.uniform1f(u.uBrowThickness, browThickness); gl.uniform1f(u.uOutline, outline); gl.uniform1f(u.uEmissive, emissive); gl.uniform1f(u.uOpacity, opacity); gl.uniform1f(u.uGlossy, skull?.[3]===3 ? 0 : glossy); gl.uniform1f(u.uStripes, stripes ? 1 : 0); gl.uniform1f(u.uKnit, knit ? 1 : 0); gl.uniform1f(u.uPreserveColour, Number(preserveColour) || 0); gl.uniform4fv(u.uHatPanel, hatPanel ? [...hexToRgb(hatPanel),1] : [0,0,0,0]); gl.uniform4fv(u.uHatBand,hatBand ? [...hexToRgb(hatBand.colour),hatBand.top] : [0,0,0,-2]); gl.uniform1f(u.uFaceEnabled, face ? 1 : 0); gl.uniform1f(u.uIsFloor, isFloor ? 1 : 0); gl.uniform2fv(u.uEyeOpen, expression.eye); gl.uniform2fv(u.uGaze, gaze); gl.uniform4fv(u.uMouth, expression.mouth); gl.uniform1f(u.uWinkBlink, expression.winkBlink || 0); gl.uniform1f(u.uBlinkClosure, expression.blinkClosure || 0); gl.uniform1f(u.uBrowSpacing, expression.browSpacing ?? 1); gl.uniform3fv(u.uExpressionDetails, expression.details || [0,0,1]); gl.uniform1f(u.uMouthReaction, expression.mouthReaction || 0); gl.uniform1f(u.uMouthWave, expression.mouthWave || 0); gl.uniform1f(u.uSmileOpen, expression.smileOpen || 0); gl.uniform1f(u.uJoyEyes, expression.joyEyes || 0); gl.uniform3fv(u.uBrow, expression.brow); gl.uniform4fv(u.uFaceStyle, expression.style || [0,0,0,0]); gl.uniform4fv(u.uFaceVariation, expression.variation || [1,1,1,1]); gl.uniform1f(u.uFaceAspect, Math.hypot(model[0], model[1], model[2]) / Math.max(.0001, Math.hypot(model[4], model[5], model[6]))); const layout=faceLayout(expression, Math.hypot(model[0],model[1],model[2])/Math.max(.0001,Math.hypot(model[4],model[5],model[6])), browThickness); gl.uniform4fv(u.uFaceLayout, layout.slice(0,4)); gl.uniform2fv(u.uFaceSpread,layout.slice(4)); gl.uniform1f(u.uEyeCross, expression.cross || 0); if(this.meshView && !isFloor && !outline) {
        if(!mesh.wireVao){
          mesh.wireVao=gl.createVertexArray();gl.bindVertexArray(mesh.wireVao);
          const src=mesh.source,positions=[],normals=[],bary=[];
          src.indices.forEach((index,i)=>{positions.push(...src.positions.slice(index*3,index*3+3));normals.push(...src.normals.slice(index*3,index*3+3));bary.push(i%3===0?1:0,i%3===1?1:0,i%3===2?1:0);});
          [positions,normals,bary].forEach((values,location)=>{const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.STATIC_DRAW);gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,3,gl.FLOAT,false,0,0);});
        }
        gl.bindVertexArray(mesh.wireVao);gl.drawArrays(gl.TRIANGLES,0,mesh.count);
      } else {gl.bindVertexArray(mesh.vao);gl.drawElements(gl.TRIANGLES,mesh.count,gl.UNSIGNED_SHORT,0);}
    }

    drawGlows(scene, viewProjection) {
      if (!scene.glows || !scene.glows.length) return;
      const gl = this.gl;
      if (!this.glowProgram) {
        this.glowProgram = this.createProgram(`#version 300 es
          precision highp float;
          layout(location=0) in vec4 aCenterRadius;
          layout(location=1) in vec4 aColourOpacity;
          uniform mat4 uViewProjection;
          uniform vec3 uRight, uUp;
          out vec2 vPoint;
          out vec4 vColour;
          void main() {
            vec2 corners[6] = vec2[6](vec2(-1,-1),vec2(1,-1),vec2(1,1),vec2(-1,-1),vec2(1,1),vec2(-1,1));
            vPoint = corners[gl_VertexID]; vColour = aColourOpacity;
            vec3 offset = aCenterRadius.w < 0.0 ? vec3(vPoint.x, 0.0, vPoint.y) : uRight*vPoint.x + uUp*vPoint.y;
            vec3 world = aCenterRadius.xyz + offset*abs(aCenterRadius.w);
            gl_Position = uViewProjection*vec4(world,1.0);
          }`, `#version 300 es
          precision highp float;
          in vec2 vPoint;
          in vec4 vColour;
          out vec4 outColor;
          void main() {
            float r = length(vPoint);
            if (r >= 1.0) discard;
            float glow = exp(-4.5*r*r)*(1.0-smoothstep(.65,1.0,r));
            outColor = vec4(vColour.rgb, vColour.a*glow);
          }`);
        this.glowUniforms = this.getUniforms(this.glowProgram,['uViewProjection','uRight','uUp']);
        this.glowVAO = gl.createVertexArray(); this.glowBuffer = gl.createBuffer();
        gl.bindVertexArray(this.glowVAO); gl.bindBuffer(gl.ARRAY_BUFFER,this.glowBuffer);
        for (let i=0;i<2;i++) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i,4,gl.FLOAT,false,32,i*16); gl.vertexAttribDivisor(i,1); }
        gl.bindVertexArray(null);
      }
      const count=scene.glows.length;
      if (!this.glowData || this.glowData.length < count*8) this.glowData=new Float32Array(count*8);
      scene.glows.forEach((g,i)=>{ const c=hexToRgb(g.color || '#ffe08a'); this.glowData.set([g.x,g.y,g.z,g.ground ? -g.radius : g.radius,c[0],c[1],c[2],g.opacity ?? .3],i*8); });
      const eye=scene.camera.position, target=scene.camera.target;
      let fx=target.x-eye.x, fy=target.y-eye.y, fz=target.z-eye.z;
      const fl=Math.hypot(fx,fy,fz)||1; fx/=fl;fy/=fl;fz/=fl;
      const rl=Math.hypot(fz,fx)||1, right=[-fz/rl,0,fx/rl], up=[right[1]*fz-right[2]*fy,right[2]*fx-right[0]*fz,right[0]*fy-right[1]*fx];
      gl.useProgram(this.glowProgram); gl.uniformMatrix4fv(this.glowUniforms.uViewProjection,false,viewProjection);
      gl.uniform3fv(this.glowUniforms.uRight,right); gl.uniform3fv(this.glowUniforms.uUp,up);
      gl.bindVertexArray(this.glowVAO); gl.bindBuffer(gl.ARRAY_BUFFER,this.glowBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,this.glowData.subarray(0,count*8),gl.DYNAMIC_DRAW);
      gl.disable(gl.CULL_FACE); gl.depthMask(false); gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArraysInstanced(gl.TRIANGLES,0,6,count);
      gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    }
    drawSurfaceEdges(scene,viewProjection,width,height) {
      const gl=this.gl;
      if(!this.surfaceProgram){
        this.surfaceProgram=this.createProgram(SURFACE_VERTEX,SURFACE_FRAGMENT);
        this.surfaceUniforms=this.getUniforms(this.surfaceProgram,['uModel','uViewProjection','uSurface','uTime','uGhost','uClothMotion']);
        this.edgeProgram=this.createProgram(EDGE_VERTEX,EDGE_FRAGMENT);
        this.edgeUniforms=this.getUniforms(this.edgeProgram,['uSurfaces','uRadius']);
        this.surfaceFramebuffer=gl.createFramebuffer();this.surfaceTexture=gl.createTexture();this.surfaceDepth=gl.createRenderbuffer();this.edgeVAO=gl.createVertexArray();
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.surfaceFramebuffer);
      if(this.surfaceWidth!==width || this.surfaceHeight!==height){
        gl.bindTexture(gl.TEXTURE_2D,this.surfaceTexture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.surfaceTexture,0);
        gl.bindRenderbuffer(gl.RENDERBUFFER,this.surfaceDepth);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,width,height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,this.surfaceDepth);
        if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Surface outline framebuffer is incomplete');
        this.surfaceWidth=width;this.surfaceHeight=height;
      }
      gl.viewport(0,0,width,height);gl.clearColor(0,0,0,0);gl.clearDepth(1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.BLEND);gl.disable(gl.DITHER);gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);
      gl.useProgram(this.surfaceProgram);gl.uniformMatrix4fv(this.surfaceUniforms.uViewProjection,false,viewProjection);
      scene.objects.forEach((object,index)=>{
        if(object.isGlasses || (object.opacity ?? 1)<1 || object.outline===false)return;
        const body=object.member.body,model=object.customModel || modelMatrix(object.x,object.y,object.z,object.yaw,body.width*(object.scaleX ?? 1),body.height*(object.scaleY ?? 1),body.depth*(object.scaleZ ?? 1),object.pitch ?? 0,object.roll ?? 0);
        const owner=object.surfaceOwner ?? index+1;
        gl.uniformMatrix4fv(this.surfaceUniforms.uModel,false,model);
        gl.uniform1f(this.surfaceUniforms.uTime,scene.time || 0);
        gl.uniform1f(this.surfaceUniforms.uGhost,body.shape==='ghostSheet'?1:0);
        gl.uniform2fv(this.surfaceUniforms.uClothMotion,object.member.clothMotion || [0,0]);
        gl.uniform4f(this.surfaceUniforms.uSurface,(owner&255)/255,((owner>>8)&255)/255,(object.isGlasses?3:object.isHat?2:1)/255,1);
        // The cloth is open at the hem, so its inner surface must also contribute to the contour.
        const twoSided=body.shape==='ghostSheet';
        if(twoSided)gl.disable(gl.CULL_FACE);
        const mesh=this.meshFor(object.member);gl.bindVertexArray(mesh.vao);gl.drawElements(gl.TRIANGLES,mesh.count,gl.UNSIGNED_SHORT,0);
        if(twoSided)gl.enable(gl.CULL_FACE);
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,width,height);
      gl.disable(gl.DEPTH_TEST);gl.depthMask(false);gl.disable(gl.CULL_FACE);gl.useProgram(this.edgeProgram);
      gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,this.surfaceTexture);gl.uniform1i(this.edgeUniforms.uSurfaces,1);
      // Symmetric pixel contour, matching Canvas' inside/outside treatment.
      const cssWidth=scene.outlineViewport?.width || this.canvas.clientWidth || scene.width;
      const radius=Math.max(1,Math.min(4,Math.round(scene.outline*3*width/cssWidth)));
      gl.uniform1i(this.edgeUniforms.uRadius,radius);gl.bindVertexArray(this.edgeVAO);gl.drawArrays(gl.TRIANGLES,0,3);
      gl.depthMask(true);gl.enable(gl.DEPTH_TEST);gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);gl.enable(gl.DITHER);gl.activeTexture(gl.TEXTURE0);
    }

    drawHalloweenBats(scene) {
      if(!scene.objects.some(object=>object.member?.halloween && object.member.halloween!=='none'))return;
      const gl=this.gl;
      if(!this.batProgram){
        this.batProgram=this.createProgram(`#version 300 es
          precision highp float;
          uniform float uTime;
          uniform vec2 uViewport;
          out vec2 vBatUV;
          out float vFlap;
          out float vOpacity;
          float hash(float n){return fract(sin(n*127.1)*43758.5453);}
          void main(){
            float id=float(gl_VertexID/6)+1.0;
            vec2 corners[6]=vec2[6](vec2(-1,-1),vec2(1,-1),vec2(1,1),vec2(-1,-1),vec2(1,1),vec2(-1,1));
            vec2 corner=corners[gl_VertexID%6];
            float direction=hash(id+3.0)>.5?1.0:-1.0;
            float x=(mod(hash(id)*2.5+uTime*.2775*mix(.5,1.5,hash(id+4.0)),2.5)-1.25)*direction;
            float y=sin(uTime*mix(.24,.48,hash(id+9.0))+id*2.399)*1.06;
            float size=42.0*mix(.6,1.4,hash(id+11.0))*uViewport.y/360.0;
            float angle=sin(uTime*.9+id)*.16;
            vec2 offset=corner*vec2(size*2.0,size*1.1);
            offset=mat2(cos(angle),sin(angle),-sin(angle),cos(angle))*offset;
            gl_Position=vec4(vec2(x,y)+offset/uViewport,0,1);
            vBatUV=corner;vFlap=sin(uTime*mix(29.4,42.0,hash(id+13.0))+id*2.0);
            vOpacity=min(1.0,mix(.55,.85,hash(id+17.0))*1.2);
          }`,`#version 300 es
          precision highp float;
          in vec2 vBatUV;
          in float vFlap;
          in float vOpacity;
          out vec4 outColour;
          void main(){
            vec2 p=vBatUV;float x=abs(p.x);
            float body=length(p/vec2(.07,.24));
            float head=length((p-vec2(0,.18))/vec2(.095,.11));
            bool ears=x>.0375 && x<.085 && p.y>.19 && p.y<.38-x*1.4;
            float wingY=p.y-vFlap*.76*x;
            float top=.32*(1.0-x)+.12;
            float scallop=-.36+.16*cos(x*19.0);
            bool wing=x>.05 && x<.98 && wingY<top && wingY>scallop*(1.0-x)+.07*x;
            if(body>1.0 && head>1.0 && !ears && !wing)discard;
            outColour=vec4(.105,.065,.15,vOpacity);
          }`);
        this.batUniforms=this.getUniforms(this.batProgram,['uTime','uViewport']);
        this.batVao=gl.createVertexArray();
      }
      gl.useProgram(this.batProgram);gl.bindVertexArray(this.batVao);
      gl.uniform1f(this.batUniforms.uTime,scene.time || 0);
      gl.uniform2f(this.batUniforms.uViewport,this.canvas.width,this.canvas.height);
      gl.disable(gl.DEPTH_TEST);gl.depthMask(false);gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES,0,8*6);
      gl.disable(gl.BLEND);gl.depthMask(true);gl.enable(gl.DEPTH_TEST);
    }

    drawChristmasSnow(scene) {
      if (!scene.objects.some(object => object.member?.christmas && object.member.christmas !== 'none')) return;
      const gl=this.gl;
      if(!this.snowProgram){
        this.snowProgram=this.createProgram(`#version 300 es
          precision highp float;
          uniform float uTime;
          uniform float uScale;
          uniform vec2 uViewport;
          out vec2 vSnowUV;
          out float vAlpha;
          float hash(float n){return fract(sin(n*127.1)*43758.5453);}
          void main(){
            float id=float(gl_VertexID/6)+1.0;
            float speed=.14*mix(.6,1.4,hash(id+11.0));
            float y=1.08-mod(hash(id+31.0)*2.16+uTime*speed,2.16);
            float sway=uTime*mix(.65,1.15,hash(id+43.0))+id;
            float x=mix(-1.05,1.05,hash(id))+sin(sway)*mix(.035,.075,hash(id+47.0))+sin(sway*.47+id)*.018;
            vec2 corners[6]=vec2[6](vec2(-1,-1),vec2(1,-1),vec2(1,1),vec2(-1,-1),vec2(1,1),vec2(-1,1));
            vec2 corner=corners[gl_VertexID%6];
            float size=2.34*mix(1.0,2.5,hash(id+7.0))*uScale;
            vSnowUV=corner;
            gl_Position=vec4(vec2(x,y)+corner*size/uViewport,0.0,1.0);
            vAlpha=mix(.35,.8,hash(id+19.0))*smoothstep(-1.08,-.9,y)*(1.0-smoothstep(.9,1.08,y));
          }`,`#version 300 es
          precision highp float;
          in float vAlpha;
          in vec2 vSnowUV;
          out vec4 outColour;
          void main(){float r=length(vSnowUV);float edge=fwidth(r);float coverage=1.0-smoothstep(1.0-edge,1.0,r);outColour=vec4(.94,.97,1.0,vAlpha*coverage);}`);
        this.snowUniforms=this.getUniforms(this.snowProgram,['uTime','uScale','uViewport']);
        this.snowVao=gl.createVertexArray();
      }
      gl.useProgram(this.snowProgram);gl.bindVertexArray(this.snowVao);
      gl.uniform1f(this.snowUniforms.uTime,scene.time || 0);
      gl.uniform1f(this.snowUniforms.uScale,Math.max(1,this.canvas.height/360));
      gl.uniform2f(this.snowUniforms.uViewport,this.canvas.width,this.canvas.height);
      gl.disable(gl.DEPTH_TEST);gl.depthMask(false);gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES,0,64*6);
      gl.disable(gl.BLEND);gl.depthMask(true);gl.enable(gl.DEPTH_TEST);
    }

    render(scene) {
      this.clothStates ||= new WeakMap();
      for(const object of scene.objects){
        if(object.member.halloween!=='ghost')continue;
        const member=object.member,time=scene.time || 0;
        let previous=this.clothStates.get(member);
        if(!previous){previous={time,x:object.x,y:object.y,z:object.z,yaw:object.yaw || 0,pitch:object.pitch || 0,roll:object.roll || 0,lag:[0,0],velocity:[0,0]};this.clothStates.set(member,previous);}
        const elapsed=time-previous.time,dt=Math.min(.04,Math.max(0,elapsed));
        if(elapsed>0 && elapsed<.2){
          const yaw=object.yaw || 0,turn=Math.atan2(Math.sin(yaw-previous.yaw),Math.cos(yaw-previous.yaw))/elapsed;
          const dx=(object.x-previous.x)/elapsed,dz=(object.z-previous.z)/elapsed;
          const target=[clamp(-turn*.035-(dx*Math.cos(yaw)-dz*Math.sin(yaw))*.045-((object.roll || 0)-previous.roll)/elapsed*.025,-.16,.16),clamp(-(dx*Math.sin(yaw)+dz*Math.cos(yaw))*.045-((object.pitch || 0)-previous.pitch)/elapsed*.03,-.12,.12)];
          for(let i=0;i<2;i++){previous.velocity[i]+=(40*(target[i]-previous.lag[i])-9*previous.velocity[i])*dt;previous.lag[i]+=previous.velocity[i]*dt;}
        }else if(elapsed>=.2){previous.lag=[0,0];previous.velocity=[0,0];}
        Object.assign(previous,{time,x:object.x,y:object.y,z:object.z,yaw:object.yaw || 0,pitch:object.pitch || 0,roll:object.roll || 0});
        member.clothMotion=previous.lag;
      }
      // Accessories share the body's complete transform and all render passes.
      scene={...scene,objects:scene.objects.flatMap((source,index)=>{
        const object={...source,surfaceOwner:index+1};
        const halloweenOnly=object.member.halloween && object.member.halloween!=='none';
        const parts=halloweenOnly?[]:[...(object.member.hatParts || [])];
        const glassesDefinition=halloweenOnly?null:PixelkinAccessories.getGlasses(object.member.glasses);
        if(glassesDefinition) {
          const member=object.member, expression=this.expression(member,scene.time), b=member.body;
          const layout=faceLayout(expression,b.width/b.height,member.browThickness || 0),variation=expression.variation || [1,1,1,1];
          const t=clamp((variation[1]-1/1.4)/(1-1/1.4),0,1),spacing=.276*variation[0]*layout[4]*(.7+.3*t*t*(3-2*t));
          const originalCx=spacing*1.15*layout[0]*b.width*.5,cy=(.17*layout[5]-layout[3])*layout[1]*b.height*.5;
          const baseRx=.20475*variation[1]*1.15*layout[0]*b.width*.5,rx=baseRx*1.15*1.10*1.10,ry=rx*.88/.92,z=b.depth*.5+.045;
          const cx=rx+Math.max(0,originalCx-baseRx)*.5*.7;
          const clearLens=glassesDefinition.clear,squareLens=glassesDefinition.square;
          const tint=clearLens ? '#ffffff' : member.glassesLensColor || {dark:'#12161e',amber:'#d78c23',blue:'#379bf5',rose:'#eb4178',neon:'#00f5d2',clear:'#bee1ff'}[member.glassesTint] || '#12161e';
          for(const x of [-cx,cx]) {
            parts.push({shape:squareLens?'squareLensDisc':'lensDisc',x,y:cy,z:z+.002,width:rx*2*.7705,height:ry*2*.7705,depth:1,colour:tint,glasses:true,lens:true,lensOpacity:glassesDefinition.opacity});
            parts.push({shape:squareLens?'squareLensRing':'lensRing',x,y:cy,z:z+.002,width:rx*2,height:ry*2,depth:1,colour:member.glassesColor || '#400a56',glasses:true});
          }
          parts.push({shape:'lensBridge',x:0,y:cy+(glassesDefinition.topBridge?ry*.18:0),z:z+.002,width:Math.max(.008,2*(cx-rx)+rx*.2295),height:ry*.2295,depth:.008,colour:member.glassesColor || '#400a56',glasses:true});
          if(glassesDefinition.topBridge) {
            const barY=ry-ry*.2295*.5;
            parts.push({shape:'lensBridge',x:0,y:cy+barY,z:z+.002,width:2*cx,height:ry*.2295,depth:.008,colour:member.glassesColor || '#400a56',glasses:true});
          }
        }
        if(['skull','pumpkin'].includes(object.member.halloween)) {
          const member=object.member,b=member.body,e=this.expression(member,scene.time),l=faceLayout(e,b.width/b.height,member.browThickness || 0),v=e.variation || [1,1,1,1];
          const t=clamp((v[1]-1/1.4)/(1-1/1.4),0,1),spacing=.276*v[0]*l[4]*(.7+.3*t*t*(3-2*t));
          const pumpkin=member.halloween==='pumpkin',svgWidth=pumpkin?385:300,svgHeight=pumpkin?375:264;
          const width=b.width*l[0]*spacing*svgWidth/108.8,height=width*svgHeight/svgWidth;
          const eye=scene.camera.position,target=scene.camera.target,forward=[target.x-eye.x,target.y-eye.y,target.z-eye.z],length=Math.hypot(...forward)||1;
          const depth=((object.x-eye.x)*forward[0]+(object.y-eye.y)*forward[1]+(object.z-eye.z)*forward[2])/length;
          const strokeWidth=maskStrokeWidth(svgWidth,width*(object.scaleX ?? 1),depth,scene.camera.fov,scene.height);
          object.maskStrap=[(.17*l[5]-l[3])*l[1],(width*strokeWidth/svgWidth)/b.height,(spacing+.20475*v[1])*l[0]];
          const eyeLocalY=pumpkin?1-2*(399.55-210)/375:1-2*(317.4-200)/264;
          parts.push({shape:'skullMask',x:0,y:(.17*l[5]-l[3])*l[1]*b.height*.5-eyeLocalY*height*.5,z:b.depth*.5+.0325,width,height,depth:1,colour:'#eee8d8',glasses:true,skull:[strokeWidth,0,1,member.halloween==='pumpkin'?2:1]});
        }
        if(object.member.halloween==='devil_horns'){
          const b=object.member.body,round=b.shape==='sphere' || b.shape==='capsule',span=b.shape==='capsule'?Math.min(b.width,b.height):b.width;
          const height=clamp((b.width+b.height)*.16,.38,.65),width=height*.60,x=span*.19;
          let root=b.height*.5-.025;
          if(round){
            // Seat the whole flat base into the curved head, not just its centre.
            root=Infinity;
            for(let i=0;i<24;i++){
              const a=i/24*TAU,px=x+Math.cos(a)*width*.5,pz=Math.sin(a)*width*.5;
              let surface;
              if(b.shape==='sphere')surface=b.height*.5*Math.sqrt(Math.max(0,1-Math.pow(px/(b.width*.5),2)-Math.pow(pz/(b.depth*.5),2)));
              else {
                const r=Math.min(b.width,b.height,b.depth)*.5,horizontal=b.width>b.height,segment=Math.max(0,(horizontal?b.width:b.height)*.5-r);
                surface=horizontal?Math.sqrt(Math.max(0,r*r-Math.pow(Math.max(0,Math.abs(px)-segment),2)-pz*pz)):segment+Math.sqrt(Math.max(0,r*r-px*px-pz*pz));
              }
              root=Math.min(root,surface);
            }
            root-=.02;
          }
          for(const side of [-1,1])parts.push({shape:side<0?'devilHornLeft':'devilHornRight',x:side*x,y:root+height*.5-.025,z:0,width,height,depth:width,colour:'#dc202e'});
        }
        if(object.member.halloween==='ghost'){
          const member=object.member,b=member.body,e=this.expression(member,scene.time),l=faceLayout(e,b.width/b.height,member.browThickness || 0),v=e.variation || [1,1,1,1];
          const t=clamp((v[1]-1/1.4)/(1-1/1.4),0,1),spacing=.276*v[0]*l[4]*(.7+.3*t*t*(3-2*t));
          const sheet={...object,face:false,isHat:true,castShadow:false,glossy:0,emissive:0,opacity:1,member:{...member,palette:'#f5f2e8',gradient:false,glitter:0,knit:false,preserveColour:1,hatParts:[],armParams:null,skull:[spacing*l[0],(.17*l[5]-l[3])*l[1],.245*v[1]*l[0],3],body:{...b,shape:'ghostSheet',ghostShape:b.shape,arms:false,stripes:false}}};
          return [object,sheet];
        }
        const arms=armObjects(object);
        if(!parts.length)return [object,...arms];
        const r=rotation(object.yaw,object.pitch ?? 0,object.roll ?? 0),sx=object.scaleX ?? 1,sy=object.scaleY ?? 1,sz=object.scaleZ ?? 1;
        return [object,...arms,...parts.map(part=>{
          const x=(part.x || 0)*sx,y=part.y*sy,z=part.z*sz;
          return {...object,x:object.x+r[0]*x+r[3]*y+r[6]*z,y:object.y+r[1]*x+r[4]*y+r[7]*z,z:object.z+r[2]*x+r[5]*y+r[8]*z,isHat:true,isGlasses:Boolean(part.glasses),face:false,castShadow:!part.glasses,opacity:part.lens?part.lensOpacity:1,glossy:part.lens?.8:0,emissive:0,
            member:{seed:object.member.seed,phase:0,palette:part.colour,body:{shape:part.shape || 'sphere',lowPoly:Boolean(part.lowPoly),width:part.width,height:part.height,depth:part.depth},knit:false,preserveColour:part.glasses?2:1,hatPanel:part.panel,hatBand:part.band,skull:part.skull}};
        })];
      })};
      if (!this.available) return null; const gl = this.gl;
      const surfaceEdges=scene.mode!=='mesh' && scene.outline>.02 && scene.objects.some(object=>object.isHat || object.isArm);
      // Fixed 2 CSS-pixel blocks; preserve the original camera aspect ratio.
      const pixelStep = scene.pixelStep ?? 2;
      const renderWidth = Math.max(1, Math.ceil(scene.width / pixelStep)), renderHeight = Math.max(1, Math.ceil(scene.height / pixelStep));
      this.resize(renderWidth, renderHeight);
      const cameraEye = [scene.camera.position.x, scene.camera.position.y, scene.camera.position.z], cameraTarget = [scene.camera.target.x, scene.camera.target.y, scene.camera.target.z], viewProjection = multiply4(perspective(scene.camera.fov, scene.width / scene.height, .1, 100), lookAt(cameraEye, cameraTarget));
      const shadowLight = scene.lights.filter((light) => light.enabled && light.intensity > 0).sort((a, b) => b.intensity - a.intensity)[0], hasShadow = Boolean(shadowLight), identity = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]); let lightViewProjection = identity;
      if (hasShadow && shadowLight) {
        const eye = [shadowLight.x, Math.max(.45, shadowLight.y), shadowLight.z], target = shadowLight.target ? [shadowLight.target.x, shadowLight.target.y, shadowLight.target.z] : shadowLight.spotlight ? [shadowLight.x, 0, shadowLight.z] : [0, .2, 0], up = Math.abs(eye[1] - target[1]) > .9 ? [0, 0, -1] : [0, 1, 0], spotlightFov = clamp(2 * Math.atan((shadowLight.coneRadius || 4) / Math.max(.45, Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]))) * 1.06, .55, 1.65); lightViewProjection = multiply4(perspective(shadowLight.spotlight ? spotlightFov : 1.35, 1, .35, 26), lookAt(eye, target, up));
        if (shadowLight.directional) {
          const centre = shadowLight.target || {x:0,y:0,z:0};
          const dx=shadowLight.x-centre.x, dy=shadowLight.y-centre.y, dz=shadowLight.z-centre.z, length=Math.hypot(dx,dy,dz)||1;
          const directionalEye=[centre.x+dx/length*25,centre.y+dy/length*25,centre.z+dz/length*25];
          const extent=shadowLight.shadowExtent || 12, near=.1, far=60;
          const orthographic=new Float32Array([1/extent,0,0,0,0,1/extent,0,0,0,0,-2/(far-near),0,0,0,-(far+near)/(far-near),1]);
          lightViewProjection=multiply4(orthographic,lookAt(directionalEye,[centre.x,centre.y,centre.z],up));
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFramebuffer); gl.viewport(0, 0, this.shadowSize, this.shadowSize); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT); gl.useProgram(this.shadowProgram); gl.uniformMatrix4fv(this.shadowUniforms.uLightViewProjection, false, lightViewProjection); gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);
        scene.objects.forEach((object) => { if (object.castShadow === false) return; const scaleX = object.scaleX ?? 1, scaleY = object.scaleY ?? 1, scaleZ = object.scaleZ ?? 1, model = object.customModel || modelMatrix(object.x, object.y, object.z, object.yaw, object.member.body.width * scaleX, object.member.body.height * scaleY, object.member.body.depth * scaleZ, object.pitch ?? 0, object.roll ?? 0); gl.uniformMatrix4fv(this.shadowUniforms.uModel, false, model); const mesh = this.meshFor(object.member); gl.bindVertexArray(mesh.vao); gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0); });
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, renderWidth, renderHeight); gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.useProgram(this.program); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture); this.setCommonUniforms(scene, viewProjection, lightViewProjection, hasShadow); gl.uniform1f(this.uniforms.uOutlinePerspective, scene.outlinePerspective ? Math.hypot(scene.camera.position.x - scene.camera.target.x, scene.camera.position.y - scene.camera.target.y, scene.camera.position.z - scene.camera.target.z) : 0); gl.uniform2f(this.uniforms.uOutlineViewport, Math.max(1, scene.outlineViewport?.width || this.canvas.clientWidth || scene.width), Math.max(1, scene.outlineViewport?.height || this.canvas.clientHeight || scene.height)); gl.cullFace(gl.BACK);
      const neutralExpression = { eye: [1,1], mouth: [0,0,1,0], brow: [0,0,0], style: [0,0,0,0], variation: [1,1,1,1] };
      if (scene.floor !== false) { const floorDepth = scene.floorDepth ?? 16, floorModel = modelMatrix(0, (scene.floorY ?? 0), scene.floorZ ?? 0, 0, 36, 1, floorDepth), floorNormal = normalMatrix(0, 36, 1, floorDepth); gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); this.drawMesh(this.floorMesh, floorModel, floorNormal, [.05,.06,.08], 0, false, neutralExpression, [0,0], true); gl.disable(gl.BLEND); }
      this.drawChristmasSnow(scene);
      this.drawHalloweenBats(scene);
      gl.useProgram(this.program);
      const drawOutlines=objects=>{ if (!surfaceEdges && scene.mode !== 'mesh' && scene.outline > .02) { gl.cullFace(gl.FRONT); objects.forEach((object) => { if (object.outline === false) return; gl.uniform2fv(this.uniforms.uClothMotion,object.member.clothMotion || [0,0]); const member = object.member, mesh = this.meshFor(member), scaleX = object.scaleX ?? 1, scaleY = object.scaleY ?? 1, scaleZ = object.scaleZ ?? 1, pitch = object.pitch ?? 0, roll = object.roll ?? 0, model = object.customModel || modelMatrix(object.x, object.y, object.z, object.yaw, member.body.width * scaleX, member.body.height * scaleY, member.body.depth * scaleZ, pitch, roll), normal = object.customNormal || normalMatrix(object.yaw, member.body.width * scaleX, member.body.height * scaleY, member.body.depth * scaleZ, pitch, roll); this.drawMesh(mesh, model, normal, hexToRgb(member.palette), .054 * scene.outline, false, neutralExpression, [0,0], false, 0, member.gradient ? (member.gradientReverse ? -1 : 1) : 0, 0, 0, member.gradientComplement,1,0,[member.body.width,member.body.height,member.body.depth],false,false,member.preserveColour,null,null,member.skull); }); } gl.cullFace(gl.BACK); };
      const hats=scene.objects.filter(object=>object.isHat && !object.isGlasses && (object.opacity ?? 1)>=1);
      const solids=scene.objects.filter(object=>!object.isHat && object.outline!==false);
      drawOutlines(solids);
      // Draw solids first. The inverted-hull outline has back-face depth, which
      // can let rear particles leak into the gap between the body and stroke.
      const drawBody = (object) => { gl.uniform2fv(this.uniforms.uClothMotion,object.member.clothMotion || [0,0]); const member = object.member, mesh = this.meshFor(member), scaleX = object.scaleX ?? 1, scaleY = object.scaleY ?? 1, scaleZ = object.scaleZ ?? 1, pitch = object.pitch ?? 0, roll = object.roll ?? 0, model = object.customModel || modelMatrix(object.x, object.y, object.z, object.yaw, member.body.width * scaleX, member.body.height * scaleY, member.body.depth * scaleZ, pitch, roll), normal = object.customNormal || normalMatrix(object.yaw, member.body.width * scaleX, member.body.height * scaleY, member.body.depth * scaleZ, pitch, roll), expression = this.expression(member, scene.time); if(member.skull)gl.disable(gl.CULL_FACE); this.drawMesh(mesh, model, normal, hexToRgb(member.palette), 0, object.face !== false, expression, object.gaze || [0,0], false, object.emissive || 0, member.gradient ? (member.gradientReverse ? -1 : 1) : 0, member.glitter || 0, member.browThickness || 0, member.gradientComplement, object.opacity ?? 1, object.glossy ?? 0, [member.body.width, member.body.height, member.body.depth], member.body.stripes, member.knit, member.preserveColour, member.hatPanel, member.hatBand, member.skull, object.face!==false && !object.isArm ? object.maskStrap : null); if(member.skull)gl.enable(gl.CULL_FACE); };
      gl.cullFace(gl.BACK);
      const particles = scene.objects.filter(object => object.outline === false && !object.isGlasses);
      solids.forEach(drawBody);
      const sealOutlines=objects=>{ if (!surfaceEdges && scene.mode !== 'mesh' && scene.outline > .02) {
        // Invisible front shell seals the same expanded silhouette in depth.
        // It does not repaint bodies or outlines; foreground particles still pass.
        gl.colorMask(false,false,false,false);
        try {
          objects.forEach(object => {
            if (object.outline === false) return;
            const member=object.member, sx=member.body.width*(object.scaleX ?? 1), sy=member.body.height*(object.scaleY ?? 1), sz=member.body.depth*(object.scaleZ ?? 1), pitch=object.pitch ?? 0, roll=object.roll ?? 0;
            const model=object.customModel || modelMatrix(object.x,object.y,object.z,object.yaw,sx,sy,sz,pitch,roll), normal=object.customNormal || normalMatrix(object.yaw,sx,sy,sz,pitch,roll);
            this.drawMesh(this.meshFor(member),model,normal,hexToRgb(member.palette),.054*scene.outline,false,neutralExpression,[0,0],false);
          });
        } finally { gl.colorMask(true,true,true,true); }
      } };
      if(hats.length || particles.length || scene.glows?.length)sealOutlines(solids);
      // Hats are opaque but must respect the front-depth shell of the body's stroke.
      // Let the depth buffer resolve opaque hat intersections; sealing parts
      // individually makes their visible boundary jump when distance order flips.
      drawOutlines(hats);
      hats.forEach(drawBody);
      sealOutlines(hats);
      gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      particles.sort((a,b)=>Math.hypot(b.x-cameraEye[0],b.y-cameraEye[1],b.z-cameraEye[2])-Math.hypot(a.x-cameraEye[0],a.y-cameraEye[1],a.z-cameraEye[2])).forEach(drawBody);
      gl.depthMask(true); gl.disable(gl.BLEND);
      this.drawGlows(scene, viewProjection);
      if(surfaceEdges)this.drawSurfaceEdges(scene,viewProjection,renderWidth,renderHeight);
      // Composite glasses over the finished contour without erasing adjacent ink pixels.
      const glasses=scene.objects.filter(object=>object.isGlasses);
      if(glasses.length){
        gl.useProgram(this.program);gl.enable(gl.DEPTH_TEST);gl.depthMask(true);
        glasses.filter(object=>(object.opacity ?? 1)>=1).forEach(drawBody);
        gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);
        glasses.filter(object=>(object.opacity ?? 1)<1).sort((a,b)=>Math.hypot(b.x-cameraEye[0],b.y-cameraEye[1],b.z-cameraEye[2])-Math.hypot(a.x-cameraEye[0],a.y-cameraEye[1],a.z-cameraEye[2])).forEach(drawBody);
        gl.depthMask(true);gl.disable(gl.BLEND);
      }
      gl.bindVertexArray(null); gl.flush(); return this.canvas;
    }
  }

