#include "activity.hpp"
#include <cassert>
int main(){native::ActivityCounter a;a.input(100);a.loaded("bhop_a");a.frame("bhop_a",1,101,true);a.frame("bhop_a",1,102,false);a.frame("bhop_a",40,103,true);a.frame("bhop_a",1,130,true);assert(a.sample(false)["seconds"]==3);a.input(131);a.frame("bhop_b",.5,131.5,true);a.jump("bhop_b");a.attempt("bhop_b");auto s=a.sample(true);assert(s["seconds"]==3.5&&s["jumps"]==1&&s["maps"].size()==2&&s["maps"][1]["attempts"]==1);a.frame("bhop_a",NAN,132,true);a.frame("bhop_a",1,NAN,true);assert(a.sample(true)["seconds"]==3.5);}
