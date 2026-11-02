  const profile=(label,weights,hold,wink)=>Object.freeze({label,weights:Object.freeze(weights),hold:Object.freeze(hold),wink});
  const profiles=Object.freeze({
    sleepy:profile('Sleepy',{sleepy:65,neutral:20,happy:10,curious:5},[5,10],.01),
    grumpy:profile('Grumpy',{angry:40,indignant:25,neutral:20,happy:10,joy:5},[3,7],.02),
    positive:profile('Positive',{happy:60,neutral:15,curious:15,joy:10},[3,7],.16),
    enthusiastic:profile('Enthusiastic',{celebration:55,joy:25,happy:15,curious:5},[2.5,5.5],.12),
    joyful:profile('Joyful',{joy:60,happy:25,celebration:10,neutral:5},[3,7],.18),
    gloomy:profile('Gloomy',{sad:60,neutral:25,sleepy:10,happy:5},[4,9],.01),
    mischievous:profile('Evil',{maleficent:55,angry:15,indignant:10,happy:15,curious:5},[3,7],.18),
    curious:profile('Curious',{curious:60,neutral:15,happy:15,surprised:10},[2.5,6],.06),
    skittish:profile('Skittish',{surprised:50,curious:20,neutral:20,sad:5,happy:5},[2.5,5.5],.01),
    indignant:profile('Indignant',{indignant:60,angry:20,neutral:15,happy:5},[3.5,8],.02),
    neutral:profile('Neutral',{neutral:65,happy:15,curious:15,sleepy:5},[4,8],.04)
  });
  function pick(weights,random=Math.random){
    const entries=Object.entries(weights),total=entries.reduce((sum,[,weight])=>sum+weight,0);
    let cursor=random()*total;
    for(const [name,weight] of entries){cursor-=weight;if(cursor<0)return name;}
    return entries[entries.length-1][0];
  }
  class Controller {
    constructor(name='neutral',random=Math.random){this.random=random;this.select(name);}
    select(name){this.name=profiles[name]?name:'neutral';this.current=null;this.remaining=0;this.manualRemaining=0;this.wasBlocked=false;this.afterWink=null;}
    manual(seconds=6){this.manualRemaining=seconds;this.current=null;this.remaining=0;this.afterWink=null;}
    update(dt,blocked=false){
      if(blocked){this.wasBlocked=true;return null;}
      if(this.manualRemaining>0){this.manualRemaining=Math.max(0,this.manualRemaining-dt);return null;}
      const resume=this.wasBlocked;this.wasBlocked=false;
      this.remaining-=dt;
      if(this.remaining>0 && this.current)return resume?this.current:null;
      const p=profiles[this.name];
      if(this.afterWink){this.current=this.afterWink;this.afterWink=null;}
      else {
        const next=pick(p.weights,this.random);
        if(this.current && this.current!=='wink' && this.random()<p.wink){this.afterWink=next;this.current='wink';this.remaining=1.5;return this.current;}
        this.current=next;
      }
      this.remaining=p.hold[0]+(p.hold[1]-p.hold[0])*this.random();
      return this.current;
    }
  }
  export const PixelkinPersonalities={profiles,pick,Controller};
  export { profiles, pick, Controller };
