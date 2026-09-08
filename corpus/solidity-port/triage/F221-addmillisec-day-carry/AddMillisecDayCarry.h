using namespace QPI;

struct AddMillisecDayCarry2
{
};

struct AddMillisecDayCarry : public ContractBase
{
    struct StateData
    {
        uint64 ok;
        uint64 year;
        uint64 month;
        uint64 day;
        uint64 hour;
        uint64 minute;
        uint64 second;
        uint64 millisec;
        uint64 calls;
    };

    struct Run_input
    {
        uint64 a;
        uint64 b;
    };
    struct Run_output {};
    struct Run_locals
    {
        DateAndTime moment;
        sint64 delta;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Run)
    {
        locals.moment.set(2024, 1, 1, 0, 0, 0, 0, 0);
        locals.delta = input.a;
        state.mut().ok = locals.moment.addMillisec(locals.delta) ? 1 : 0;
        state.mut().year = locals.moment.getYear();
        state.mut().month = locals.moment.getMonth();
        state.mut().day = locals.moment.getDay();
        state.mut().hour = locals.moment.getHour();
        state.mut().minute = locals.moment.getMinute();
        state.mut().second = locals.moment.getSecond();
        state.mut().millisec = locals.moment.getMillisec();
        state.mut().calls++;
    }

    struct Read_input {};
    struct Read_output
    {
        uint64 ok;
        uint64 year;
        uint64 month;
        uint64 day;
        uint64 hour;
        uint64 minute;
        uint64 second;
        uint64 millisec;
        uint64 calls;
    };

    PUBLIC_FUNCTION(Read)
    {
        output.ok = state.get().ok;
        output.year = state.get().year;
        output.month = state.get().month;
        output.day = state.get().day;
        output.hour = state.get().hour;
        output.minute = state.get().minute;
        output.second = state.get().second;
        output.millisec = state.get().millisec;
        output.calls = state.get().calls;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Run, 1);
    }

    INITIALIZE()
    {
        state.mut().calls = 0;
    }
};
