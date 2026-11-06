// ===== AudioWorklet processors (chargés via Blob URL) =====
class RecProcessor extends AudioWorkletProcessor{
  constructor(){super();this.on=false;this.port.onmessage=e=>{this.on=e.data.rec};this.n=0;this.peak=0}
  process(inputs){
    const ch=inputs[0]&&inputs[0][0];
    if(ch){
      let p=0;for(let i=0;i<ch.length;i++){const a=Math.abs(ch[i]);if(a>p)p=a}
      this.peak=Math.max(p,this.peak*0.9);
      if(this.on)this.port.postMessage({t:currentFrame,d:ch.slice(0)});
      if(++this.n%8===0)this.port.postMessage({peak:this.peak});
    }
    return true;
  }
}
registerProcessor('rec-proc',RecProcessor);

// Correcteur de pitch (effet "autotune") : détection YIN + pitch shifter granulaire
class PitchProc extends AudioWorkletProcessor{
  static get parameterDescriptors(){return[
    {name:'amount',defaultValue:1,minValue:0,maxValue:1},
    {name:'speed',defaultValue:0.01,minValue:0,maxValue:0.5},
    {name:'mix',defaultValue:1,minValue:0,maxValue:1},
    {name:'shift',defaultValue:0,minValue:-12,maxValue:12}]}
  constructor(o){
    super();const po=(o&&o.processorOptions)||{};
    this.scale=po.scale||[0,2,3,5,7,8,10];this.key=po.key|0;
    this.port.onmessage=e=>{if(e.data.scale)this.scale=e.data.scale;if(e.data.key!==undefined)this.key=e.data.key};
    this.N=8192;this.W=Math.round(sampleRate*0.024);
    this.bufs=[new Float32Array(this.N),new Float32Array(this.N)];
    this.w=0;this.rp=600;this.rpOld=600;this.xf=0;this.xfN=1;this.P=Math.round(sampleRate/200);this.ratio=1;this.target=1;
    this.det=new Float32Array(1024);this.dw=0;this.dcount=0;this.dec=0;this.decN=0;
    this.hop=256;this.since=0;this.lastNote=-1;
    this.minLag=Math.floor(sampleRate/2/900);this.maxLag=Math.floor(sampleRate/2/70);
    this.win=600;this.d=new Float32Array(this.maxLag+2);this.frame=new Float32Array(this.win+this.maxLag+2);
  }
  detect(){
    const L=this.det.length,need=this.win+this.maxLag+1,f=this.frame;
    for(let i=0;i<need;i++)f[i]=this.det[(this.dw-need+i+L*4)%L];
    let rms=0;for(let i=0;i<this.win;i++)rms+=f[i]*f[i];rms=Math.sqrt(rms/this.win);
    if(rms<0.008)return 0;
    const d=this.d;d[0]=1;let run=0,best=-1;
    for(let tau=1;tau<=this.maxLag;tau++){
      let s=0;for(let i=0;i<this.win;i+=2){const x=f[i]-f[i+tau];s+=x*x}
      run+=s;d[tau]=run>0?s*tau/run:1;
    }
    for(let tau=this.minLag;tau<this.maxLag;tau++){
      if(d[tau]<0.18){while(tau+1<this.maxLag&&d[tau+1]<d[tau])tau++;best=tau;break}
    }
    if(best<0)return 0;
    const a=d[best-1],b=d[best],c=d[best+1];const den=a-2*b+c;
    const t=den!==0?best+0.5*(a-c)/den:best;
    return (sampleRate/2)/t;
  }
  process(inputs,outputs,P){
    const inp=inputs[0],out=outputs[0];if(!out||!out[0])return true;
    const n=out[0].length,chs=out.length;
    const amount=P.amount[0],speed=P.speed[0],mix=P.mix[0],shift=P.shift[0];
    const src0=inp&&inp[0]?inp[0]:null;
    for(let i=0;i<n;i++){
      const x0=src0?src0[i]:0;
      // décimation x2 pour la détection
      this.dec+=x0;if(++this.decN===2){this.det[this.dw]=this.dec*0.5;this.dw=(this.dw+1)%this.det.length;this.dec=0;this.decN=0}
      if(++this.since>=this.hop){
        this.since=0;const f=this.detect();let tgt=Math.pow(2,shift/12);
        if(f>0){
          this.P=this.P*0.5+(sampleRate/f)*0.5;
          const m=69+12*Math.log2(f/440);
          let bestN=m,bd=99;
          for(let o=-1;o<=10;o++)for(const s of this.scale){const nn=o*12+this.key+s;const dd=Math.abs(nn-m);if(dd<bd){bd=dd;bestN=nn}}
          if(this.lastNote>=0&&Math.abs(bestN-this.lastNote)===1&&Math.abs(m-this.lastNote)<0.65)bestN=this.lastNote;
          this.lastNote=bestN;
          tgt*=Math.pow(2,(bestN-m)*amount/12);
        }
        this.target=tgt;
      }
      const k=speed<=0.0005?1:1-Math.exp(-1/(speed*sampleRate));
      this.ratio+=(this.target-this.ratio)*k;
      // lecture à vitesse "ratio" avec sauts d'une période entière + fondu (PSOLA simplifié)
      const Pd=this.P,X=Math.min(256,Pd|0),minD=8+X,maxD=minD+Math.max(3*Pd,700);
      this.rp+=1-this.ratio;if(this.xf>0)this.rpOld+=1-this.ratio;
      if(this.xf<=0){
        if(this.rp<minD){this.rpOld=this.rp;this.rp+=Math.ceil((minD+Pd-this.rp)/Pd)*Pd;this.xf=this.xfN=X}
        else if(this.rp>maxD){this.rpOld=this.rp;this.rp-=Math.ceil((this.rp-(maxD-Pd))/Pd)*Pd;if(this.rp<minD)this.rp+=Pd;this.xf=this.xfN=X}
      }
      const fo=this.xf>0?this.xf/this.xfN:0;if(this.xf>0)this.xf--;
      for(let c=0;c<chs;c++){
        const b=this.bufs[c<2?c:1];const x=inp&&inp[c]?inp[c][i]:x0;b[this.w]=x;
        const rd=dd=>{let r=this.w-dd;if(r<0)r+=this.N;const i1=r|0,f1=r-i1;return b[i1]+(b[(i1+1)%this.N]-b[i1])*f1};
        let y=rd(this.rp);if(fo>0)y=y*(1-fo)+rd(this.rpOld)*fo;
        out[c][i]=x*(1-mix)+y*mix;
      }
      this.w=(this.w+1)%this.N;
    }
    return true;
  }
}
registerProcessor('pitch-proc',PitchProc);

class GateProc extends AudioWorkletProcessor{
  static get parameterDescriptors(){return[{name:'thr',defaultValue:-50},{name:'rel',defaultValue:0.12}]}
  constructor(){super();this.env=0;this.g=0;this.hold=0}
  process(inputs,outputs,P){
    const inp=inputs[0],out=outputs[0];if(!out[0])return true;
    const thr=Math.pow(10,P.thr[0]/20),rel=P.rel[0],n=out[0].length;
    const att=1-Math.exp(-1/(0.002*sampleRate)),rl=1-Math.exp(-1/(Math.max(0.01,rel)*sampleRate));
    for(let i=0;i<n;i++){
      let a=0;for(let c=0;c<inp.length;c++)a=Math.max(a,Math.abs(inp[c][i]));
      this.env=Math.max(a,this.env*0.9995);
      if(this.env>thr)this.hold=Math.floor(0.03*sampleRate);
      const open=this.hold-->0?1:0;
      this.g+=(open-this.g)*(open?att:rl);
      for(let c=0;c<out.length;c++)out[c][i]=(inp[c]?inp[c][i]:0)*this.g;
    }
    return true;
  }
}
registerProcessor('gate-proc',GateProc);
