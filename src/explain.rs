//! Long-form explanations for `pseudo explain <CODE>`.

pub fn explain(code: &str) -> Option<&'static str> {
    Some(match code.to_uppercase().as_str() {
        "E0001" => {
            "A character that is not part of pseudocode appeared in the source.\n\n\
            Pseudocode uses `←` (or `<-`) for assignment, `<>` for \"not equal\",\n\
            `AND`/`OR`/`NOT` for logic and `MOD` for remainders. There are no\n\
            semicolons or braces."
        }
        "E0002" => {
            "A string or character literal was not closed before the end of the line.\n\n\
            STRING literals use double quotes and CHAR literals single quotes:\n\n\
            \x20   Name ← \"Ada\"\n    Initial ← 'A'"
        }
        "E0003" => {
            "A literal is malformed: a CHAR with more than one character, an integer\n\
            that does not fit in 64 bits, or an impossible date such as 31/02/2024."
        }
        "E0100" => {
            "The parser expected a particular token and found something else.\n\n\
            The message says what was expected. Common causes are a missing `THEN`\n\
            after an IF condition, `=` used for assignment instead of `←`, or two\n\
            statements written on the same line."
        }
        "E0101" => {
            "A block was opened but never closed.\n\n\
            Every IF needs ENDIF, WHILE needs ENDWHILE, FOR needs NEXT, REPEAT\n\
            needs UNTIL, CASE needs ENDCASE, PROCEDURE needs ENDPROCEDURE, and so on."
        }
        "E0102" => {
            "A block was closed with the wrong keyword, or a closing keyword appeared\n\
            with no block to close.\n\n\
            \x20   WHILE X < 10\n        IF X = 5 THEN\n            OUTPUT X\n    ENDWHILE    // error: the IF must be closed with ENDIF first"
        }
        "E0103" => {
            "Keywords, type names and built-in functions are written in upper case.\n\n\
            `if`, `Output` and `integer` are identifiers, not keywords. Write `IF`,\n\
            `OUTPUT` and `INTEGER`."
        }
        "E0200" => {
            "A name was used that has not been declared.\n\n\
            Variables must be declared with DECLARE before use; routines must be\n\
            defined somewhere in the file. Names are case sensitive: `total` and\n\
            `Total` are different."
        }
        "E0201" => "The same name was declared twice in the same scope.",
        "E0202" => {
            "A CONSTANT was assigned to. Constants cannot change after declaration;\n\
            use DECLARE for values that change."
        }
        "E0203" => {
            "A type name is not known. Types are INTEGER, REAL, BOOLEAN, CHAR,\n\
            STRING, DATE, ARRAY[..] OF <type>, or a TYPE/CLASS declared earlier."
        }
        "E0204" => {
            "The variable after NEXT must be the counter of the FOR loop it closes.\n\n\
            \x20   FOR I ← 1 TO 10\n        ...\n    NEXT I"
        }
        "E0205" => "BREAK and CONTINUE may only appear inside WHILE, REPEAT or FOR loops.",
        "E0206" => {
            "RETURN was used incorrectly. In a FUNCTION, RETURN must be followed by a\n\
            value of the declared type. In a PROCEDURE, RETURN takes no value. The\n\
            main program cannot RETURN."
        }
        "E0207" => "A FUNCTION contains no RETURN statement, so it can never produce its result.",
        "E0300" => {
            "A value of one type was used where another type is required.\n\n\
            INTEGER converts to REAL and CHAR to STRING automatically; every other\n\
            conversion must be written out, e.g. NUM_TO_STR(X), STR_TO_NUM(S), INT(R)."
        }
        "E0301" => "A routine was called with the wrong number of arguments.",
        "E0302" => {
            "Something that is not a routine was called, a routine was used without\n\
            calling it, or a PROCEDURE (which produces no value) was used as a value.\n\n\
            PROCEDUREs are invoked with CALL; FUNCTIONs are used inside expressions."
        }
        "E0303" => {
            "An operator was applied to operands of unsuitable types.\n\n\
            `+ - * /` need numbers, `&` joins STRING/CHAR values, `DIV`/`MOD` need\n\
            INTEGERs, and `AND`/`OR`/`NOT` need BOOLEANs."
        }
        "E0304" => {
            "An array was used incorrectly: wrong number of indices, an index known\n\
            to be out of bounds, non-constant bounds, or indexing a non-array."
        }
        "E0305" => "A field was accessed that the record or class does not have.",
        "E0306" => "A method was called that the class (and its superclasses) does not define.",
        "E0307" => {
            "A PRIVATE field or method was used from outside its class.\n\n\
            PRIVATE members are visible only to the methods of the class that declares\n\
            them (not even to subclasses). Expose behaviour through PUBLIC methods."
        }
        "E0308" => {
            "A BYREF parameter was given a value instead of a variable. BYREF lets the\n\
            routine change the caller's variable, so the argument must be a variable,\n\
            array element or field."
        }
        "E0309" => "The target of an assignment, INPUT or `^` is not a variable.",
        "E0400" => {
            "A class definition is invalid: unknown or non-class superclass, SUPER used\n\
            outside a subclass, or an override whose signature differs from the method\n\
            it replaces."
        }
        "W0001" => {
            "A variable or parameter is never used. Prefix the name with `_` to\n\
            silence the warning."
        }
        "W0002" => {
            "A statement can never run because an earlier statement always leaves\n\
            the block (RETURN, BREAK, CONTINUE)."
        }
        "W0003" => "A FUNCTION was invoked with CALL, discarding its result.",
        "W0004" => "A declaration hides another one with the same name.",
        "W0005" => "A CASE statement has no branches.",
        "W0007" => {
            "Some path through a FUNCTION reaches ENDFUNCTION without RETURN. If it\n\
            happens at run time the program stops with error R0008."
        }
        "R0001" => {
            "An array index was outside the declared bounds. Pseudocode arrays have\n\
            explicit bounds, usually starting at 1: ARRAY[1:10] has indices 1 to 10."
        }
        "R0002" => {
            "A variable, array element or field was read before it was given a value.\n\
            DECLARE reserves storage but does not initialise it."
        }
        "R0003" => "Arithmetic failed: division by zero or INTEGER overflow.",
        "R0004" => {
            "A value had the wrong type at run time. This happens where the compiler\n\
            could not know the type, e.g. results of routines defined later in the file."
        }
        "R0005" => {
            "A file operation failed: file missing, not open, opened in the wrong\n\
            mode, or read past its end (use EOF to check)."
        }
        "R0006" => {
            "INPUT, READFILE or STR_TO_NUM received text that is not a valid value of\n\
            the required type."
        }
        "R0007" => "Too many nested calls, usually recursion without a reachable base case.",
        "R0008" => "A FUNCTION reached ENDFUNCTION without executing RETURN.",
        "R0009" => {
            "An object or pointer was used before it referred to anything (no NEW,\n\
            or a pointer never assigned)."
        }
        "R0010" => {
            "A message was sent to an object whose class (and superclasses) has no\n\
            method of that name — Smalltalk's \"doesNotUnderstand\"."
        }
        "R0011" => "A PRIVATE member was accessed from outside its class at run time.",
        "R0012" => "A built-in function was given an argument outside its valid range.",
        _ => return None,
    })
}
