export class StaleIdentityError extends Error {
  constructor() {super("身份已切换，已忽略旧身份的响应。");this.name="StaleIdentityError";}
}
/** An in-flight response must belong to the identity which started it. */
export class IdentityScope {
  private generation=0;
  advance(){this.generation++;}
  checkpoint(){const generation=this.generation;return()=>{if(generation!==this.generation)throw new StaleIdentityError();};}
  async guard<T>(work:()=>Promise<T>):Promise<T>{
    const generation=this.generation;
    try {const result=await work();if(generation!==this.generation)throw new StaleIdentityError();return result;}
    catch(error){if(generation!==this.generation)throw new StaleIdentityError();throw error;}
  }
}
