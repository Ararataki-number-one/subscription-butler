import type {ReportOptions} from "../operations/types";

/** Keeps automatic refresh on the last successfully submitted report filters. */
export class ReportSession {
  private sequence=0;
  private pending=false;
  private submitted:ReportOptions|null=null;
  reset(){this.sequence++;this.pending=false;this.submitted=null;}
  refreshFilters():ReportOptions|null{return !this.pending&&this.submitted?{...this.submitted}:null;}
  begin(filters:ReportOptions){
    const sequence=++this.sequence,submitted={...filters};this.pending=true;
    return {
      commit:()=>{if(sequence!==this.sequence)return false;this.submitted=submitted;return true;},
      finish:()=>{if(sequence===this.sequence)this.pending=false;},
    };
  }
}
